import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Since the API only has admin users, a valid JWT is enough to grant access.
 * JwtStrategy.validate() already checks the `admin` table and returns the admin entity.
 */
export function AdminAuth() {
  return applyDecorators(UseGuards(AuthGuard('jwt')));
}
