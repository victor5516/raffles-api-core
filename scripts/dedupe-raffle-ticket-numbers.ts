import { DataSource, In } from 'typeorm';
import * as dotenv from 'dotenv';
import databaseConfig from '../src/config/database.config';
import {
  Purchase,
  PurchaseStatus,
} from '../src/modules/purchases/entities/purchase.entity';
import { Raffle } from '../src/modules/raffles/entities/raffle.entity';

dotenv.config();

const config = (databaseConfig as any)();

const dataSource = new DataSource({
  ...config,
});

const RAFFLE_UID = process.env.RAFFLE_UID || 'cb2ad5d1-cca6-4936-bcb6-85b11d7e4b8d';
const DRY_RUN = true;

interface DuplicateRow {
  ticket_number: number;
  purchase_uid: string;
  submitted_at: string;
}

/**
 * Deduplica números de ticket en una rifa: deja el número en la primera compra
 * (por submitted_at) y asigna a las demás un número disponible aleatorio.
 * Excluye compras con status rejected.
 */
async function dedupeRaffleTicketNumbers() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const raffleRepo = dataSource.getRepository(Raffle);
    const purchaseRepo = dataSource.getRepository(Purchase);

    const raffle = await raffleRepo.findOne({ where: { uid: RAFFLE_UID } });
    if (!raffle) {
      console.error(`Raffle not found: ${RAFFLE_UID}`);
      process.exit(1);
    }
    console.log(`Raffle: ${raffle.title} (totalTickets: ${raffle.totalTickets})`);

    // 1) Duplicados: (ticket_number, purchase_uid, submitted_at) solo para números que están en >1 compra
    const duplicatesRaw = await dataSource.query(
      `SELECT num.num AS ticket_number, p.uid AS purchase_uid, p.submitted_at
       FROM purchase p
       CROSS JOIN LATERAL unnest(p.ticket_numbers) AS num(num)
       WHERE p.raffle_id = $1
         AND p.status != $2
         AND p.ticket_numbers IS NOT NULL
         AND num.num IN (
           SELECT n.num FROM purchase p2
           CROSS JOIN LATERAL unnest(p2.ticket_numbers) AS n(num)
           WHERE p2.raffle_id = $1 AND p2.status != $2
           GROUP BY n.num
           HAVING COUNT(DISTINCT p2.uid) > 1
         )
       ORDER BY num.num, p.submitted_at`,
      [RAFFLE_UID, PurchaseStatus.REJECTED],
    );

    if (duplicatesRaw.length === 0) {
      console.log('No duplicate ticket numbers found. Exiting.');
      return;
    }

    // One row per occurrence of a duplicated number. Sort by ticket_number, submitted_at.
    const rows = (duplicatesRaw as DuplicateRow[]).map((r) => ({
      ticket_number: Number(r.ticket_number),
      purchase_uid: r.purchase_uid,
      submitted_at: r.submitted_at,
    }));
    rows.sort(
      (a, b) =>
        a.ticket_number - b.ticket_number ||
        new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime() ||
        a.purchase_uid.localeCompare(b.purchase_uid),
    );

    // For each duplicated number, first occurrence (earliest purchase) keeps it; rest need replacement.
    const toReplace: { purchase_uid: string; oldNum: number }[] = [];
    let currentNum = -1;
    let firstSeen = true;
    for (const r of rows) {
      if (r.ticket_number !== currentNum) {
        currentNum = r.ticket_number;
        firstSeen = true;
      }
      if (firstSeen) {
        firstSeen = false;
        continue; // keeper
      }
      toReplace.push({ purchase_uid: r.purchase_uid, oldNum: r.ticket_number });
    }

    // 2) Build set of all currently taken numbers (non-rejected)
    const takenResult = await dataSource.query(
      `SELECT unnest(ticket_numbers) AS num FROM purchase
       WHERE raffle_id = $1 AND status != $2 AND ticket_numbers IS NOT NULL`,
      [RAFFLE_UID, PurchaseStatus.REJECTED],
    );
    const taken = new Set<number>(takenResult.map((r: { num: number }) => Number(r.num)));

    // 3) Assign a random available number for each replacement
    const purchaseUpdates = new Map<string, { oldNum: number; newNum: number }[]>();

    for (const { purchase_uid, oldNum } of toReplace) {
      if (!purchaseUpdates.has(purchase_uid)) {
        purchaseUpdates.set(purchase_uid, []);
      }
      let newNum: number;
      let attempts = 0;
      const maxAttempts = raffle.totalTickets * 2;
      do {
        newNum = Math.floor(Math.random() * raffle.totalTickets);
        attempts++;
        if (attempts > maxAttempts) {
          console.error(
            `Could not find available number for purchase ${purchase_uid} (replacing ${oldNum})`,
          );
          process.exit(1);
        }
      } while (taken.has(newNum));

      taken.add(newNum);
      purchaseUpdates.get(purchase_uid)!.push({ oldNum, newNum });
    }

    if (purchaseUpdates.size === 0) {
      console.log('No purchases to update. Exiting.');
      return;
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Would apply the following changes:');
      for (const [uid, changes] of purchaseUpdates) {
        console.log(`  ${uid}: ${changes.map((c) => `${c.oldNum} -> ${c.newNum}`).join(', ')}`);
      }
      console.log('\nRun without DRY_RUN=true to apply.');
      return;
    }

    // 4) Load full purchases and apply new numbers
    const purchaseIds = Array.from(purchaseUpdates.keys());
    const purchases = await purchaseRepo.find({
      where: { uid: In(purchaseIds), raffleId: RAFFLE_UID },
    });

    if (purchases.length !== purchaseIds.length) {
      console.warn('Some purchases not found; skipping missing.');
    }

    await dataSource.transaction(async (manager) => {
      for (const purchase of purchases) {
        const changes = purchaseUpdates.get(purchase.uid);
        if (!changes || !purchase.ticketNumbers) continue;

        const arr = [...purchase.ticketNumbers];
        for (const { oldNum, newNum } of changes) {
          const idx = arr.indexOf(oldNum);
          if (idx !== -1) arr[idx] = newNum;
        }
        purchase.ticketNumbers = arr;
        await manager.save(Purchase, purchase);
        console.log(
          `Updated purchase ${purchase.uid}: replaced [${changes.map((c) => `${c.oldNum}->${c.newNum}`).join(', ')}]`,
        );
      }
    });

    console.log('\nDone. Deduplication applied.');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

dedupeRaffleTicketNumbers();
