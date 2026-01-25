import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminRole } from '../enums/admin-role.enum';
import { Roles } from './roles.decorator';
import { RolesGuard } from '../guards/roles.guard';

/**
 * Composite decorator for authentication and optional role-based authorization.
 * If roles are provided, applies both JWT authentication and role-based authorization.
 * If no roles are provided, only applies JWT authentication.
 *
 * @param roles - Optional AdminRole or array of AdminRole values. If provided, only admins with these roles can access.
 * @returns Decorator that applies the necessary guards
 *
 * @example
 * // Only authentication required
 * @Auth()
 *
 * // Only SUPER_ADMIN can access
 * @Auth(AdminRole.SUPER_ADMIN)
 *
 * // VERIFIER or SUPER_ADMIN can access
 * @Auth([AdminRole.VERIFIER, AdminRole.SUPER_ADMIN])
 */
export function Auth(...roles: AdminRole[] | AdminRole[][]): ReturnType<typeof applyDecorators> {
  // Handle case where an array is passed: @Auth([AdminRole.VERIFIER, AdminRole.SUPER_ADMIN])
  if (roles.length === 1 && Array.isArray(roles[0])) {
    const roleArray = roles[0] as AdminRole[];
    if (roleArray.length === 0) {
      return applyDecorators(UseGuards(AuthGuard('jwt')));
    }
    return applyDecorators(
      Roles(...roleArray),
      UseGuards(AuthGuard('jwt'), RolesGuard),
    );
  }

  // Handle case where no roles or individual roles are passed: @Auth() or @Auth(AdminRole.SUPER_ADMIN)
  const roleArray = roles as AdminRole[];
  if (roleArray.length === 0) {
    // Only authentication, no role check
    return applyDecorators(UseGuards(AuthGuard('jwt')));
  }

  // Authentication + role-based authorization
  return applyDecorators(
    Roles(...roleArray),
    UseGuards(AuthGuard('jwt'), RolesGuard),
  );
}

/**
 * Since the API only has admin users, a valid JWT is enough to grant access.
 * JwtStrategy.validate() already checks the `admin` table and returns the admin entity.
 * This is kept for backward compatibility. Consider using @Auth() instead.
 */
export function AdminAuth() {
  return applyDecorators(UseGuards(AuthGuard('jwt')));
}
