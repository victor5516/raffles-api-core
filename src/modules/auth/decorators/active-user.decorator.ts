import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Admin } from '../entities/admin.entity';

export const ActiveUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): Admin => {
    const request = ctx.switchToHttp().getRequest<{ user: Admin }>();
    return request.user;
  },
);
