import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

function sanitizeHeaders(headers: Record<string, unknown> | undefined) {
  if (!headers) return {};

  const deny = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-forwarded-client-cert',
    'proxy-authorization',
  ]);

  const allow = new Set([
    'user-agent',
    'x-forwarded-for',
    'x-real-ip',
    'referer',
    'origin',
    'host',
    'content-type',
    'content-length',
    'accept',
    'accept-encoding',
    'accept-language',
    'x-request-id',
  ]);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (deny.has(k)) continue;
    if (!allow.has(k)) continue;
    out[k] = value;
  }
  return out;
}

function pickPurchaseBody(body: unknown) {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;

  const picked: Record<string, unknown> = {
    raffleId: b.raffleId,
    paymentMethodId: b.paymentMethodId,
    ticket_quantity: b.ticket_quantity,
    ticket_numbers: b.ticket_numbers,
  };

  if (Array.isArray(b.payments)) {
    const refs = (b.payments as unknown[])
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>).reference : undefined))
      .filter((r): r is string => typeof r === 'string')
      .map((r) => (r.length > 24 ? `${r.slice(0, 24)}…` : r));

    picked.payments = {
      count: b.payments.length,
      references: refs.slice(0, 10),
    };
  }

  return picked;
}

@Injectable()
export class PurchaseSentryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((error) => {
        const http = context.switchToHttp();
        const req = http.getRequest();

        Sentry.withScope((scope) => {
          scope.setTag('module', 'purchases');

          scope.setExtra('request', {
            method: req?.method,
            url: req?.originalUrl ?? req?.url,
            ip: req?.ip,
          });
          scope.setExtra('body', pickPurchaseBody(req?.body));
          scope.setExtra('headers', sanitizeHeaders(req?.headers));

          const user = req?.user;
          if (user && typeof user === 'object') {
            const u = user as Record<string, unknown>;
            const id = u.sub ?? u.id;
            const email = u.email;
            const role = u.role;

            scope.setUser({
              id: typeof id === 'string' || typeof id === 'number' ? String(id) : undefined,
              email: typeof email === 'string' ? email : undefined,
              ...(typeof role === 'string' ? { role } : {}),
            });
          }

          Sentry.captureException(error);
        });

        return throwError(() => error);
      }),
    );
  }
}
