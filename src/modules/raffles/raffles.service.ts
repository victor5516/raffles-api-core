import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Raffle } from './entities/raffle.entity';
import { CreateRaffleDto } from './dto/create-raffle.dto';
import { UpdateRaffleDto } from './dto/update-raffle.dto';

@Injectable()
export class RafflesService {
  constructor(
    @InjectRepository(Raffle)
    private raffleRepository: Repository<Raffle>,
  ) {}

  async create(createRaffleDto: CreateRaffleDto) {
    const raffle = this.raffleRepository.create({
      ...createRaffleDto,
      deadline: new Date(createRaffleDto.deadline),
      digitsLength: createRaffleDto.digits_length,
      ticketPrice: createRaffleDto.ticket_price,
      totalTickets: createRaffleDto.total_tickets,
      imageUrl: createRaffleDto.image_url,
    });
    return this.raffleRepository.save(raffle);
  }

  async findAllEfficient() {
    const qb = this.raffleRepository
      .createQueryBuilder('raffle')
      .loadRelationCountAndMap('raffle.ticketsSold', 'raffle.tickets')
      .orderBy('raffle.created_at', 'DESC');

    const raffles = await qb.getMany();
    return raffles.map((r) => ({
      ...r,
      tickets_sold: (r as any).ticketsSold,
      percentage_sold:
        r.totalTickets > 0
          ? ((r as any).ticketsSold / r.totalTickets) * 100
          : 0,
    }));
  }

  async findOne(uid: string) {
    const raffle = await this.raffleRepository.findOne({ where: { uid } });
    if (!raffle) throw new NotFoundException('Raffle not found');
    return raffle;
  }

  async update(uid: string, updateRaffleDto: UpdateRaffleDto) {
    const raffle = await this.findOne(uid);

    const updateData: Partial<Raffle> = {};
    if (updateRaffleDto.title) updateData.title = updateRaffleDto.title;
    if (updateRaffleDto.description)
      updateData.description = updateRaffleDto.description;
    if (updateRaffleDto.deadline)
      updateData.deadline = new Date(updateRaffleDto.deadline);
    if (updateRaffleDto.digits_length)
      updateData.digitsLength = updateRaffleDto.digits_length;
    if (updateRaffleDto.ticket_price)
      updateData.ticketPrice = updateRaffleDto.ticket_price;
    if (updateRaffleDto.total_tickets)
      updateData.totalTickets = updateRaffleDto.total_tickets;
    if (updateRaffleDto.image_url)
      updateData.imageUrl = updateRaffleDto.image_url;
    if (updateRaffleDto.status) updateData.status = updateRaffleDto.status;

    await this.raffleRepository.update(uid, updateData);
    return this.findOne(uid);
  }

  async remove(uid: string) {
    const result = await this.raffleRepository.delete(uid);
    if (result.affected === 0) throw new NotFoundException('Raffle not found');
  }
}
