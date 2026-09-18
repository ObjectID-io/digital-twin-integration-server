import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider } from '../security/auth.js';
import { authMiddleware } from '../security/auth.js';
import { AppError } from '../common/errors.js';
import type { TwinSharing } from './service.js';
import type { TenantRegistry } from '../security/tenants.js';

export function twinManagementAuth(auth: AuthProvider, sharing: Pick<TwinSharing, 'read'>, tenants: Pick<TenantRegistry, 'findBySubscriptionId'>) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const token = request.header('x-objectid-twin-session');
    if (!token) return authMiddleware(auth)(request, response, next);
    try {
      const match = request.path.match(/^\/twins\/(0x[0-9a-f]{64})(?:\/|$)/i);
      if (!match) throw new AppError('TWIN_SESSION_SCOPE', 'Twin sessions cannot access subscription or account resources', 403, 'AUTHORIZATION');
      const access = await sharing.read(match[1]!.toLowerCase(), token);
      if (!(access.rights.owner || access.rights.admin)) throw new AppError('TWIN_ADMIN_REQUIRED', 'Current owner or Admin required', 403, 'AUTHORIZATION');
      const accounting = await tenants.findBySubscriptionId(String(access.fields.subscription_id));
      if (!accounting) throw new AppError('TWIN_SUBSCRIPTION_UNAVAILABLE', 'Twin subscription is not registered on this server', 409, 'AUTHORIZATION');
      request.auth = { subject: access.did, claims: { did: access.did, twinSession: true }, accounting };
      next();
    } catch (error) { next(error); }
  };
}
