import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenPayload, PrincipalService } from '../auth/principal.service';
import { hasAll } from '../rbac/permissions';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { DEVICE_TOKEN_OK, FEATURE_KEY, IS_PUBLIC, OPTIONAL_AUTH, PERMISSIONS_KEY } from './decorators';
import { FeatureName } from './features';

/**
 * Authentication. Bearer token is either
 *   • an account JWT (always accepted), or
 *   • a device token (only where @AllowDeviceToken / @OptionalAuth is set).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flag = (k: string) => !!this.reflector.getAllAndOverride<boolean>(k, [ctx.getHandler(), ctx.getClass()]);
    const isPublic = flag(IS_PUBLIC), deviceOk = flag(DEVICE_TOKEN_OK), optional = flag(OPTIONAL_AUTH);
    const req = ctx.switchToHttp().getRequest();
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!bearer) {
      if (isPublic || optional) return true;
      throw new UnauthorizedException('Authentication required.');
    }
    let payload: AccessTokenPayload | null = null;
    try { payload = await this.jwt.verifyAsync<AccessTokenPayload>(bearer, { secret: this.config.getOrThrow('JWT_SECRET') }); } catch { payload = null; }
    if (payload) {
      if (isPublic) return true;
      req.user = await this.principals.account(payload);
      return true;
    }
    if (deviceOk || optional) {
      const device = await this.principals.deviceToken(bearer);
      if (device) { req.user = device; return true; }
    }
    if (isPublic) return true;
    throw new UnauthorizedException('Invalid or expired token.');
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user) return false;
    if (!hasAll(user.permissions, required)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.', required });
    }
    return true;
  }
}

/** Server-side Premium enforcement per DEVICE. The desktop check is UX only; this is the security boundary. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly subscriptions: SubscriptionsService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureName>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user) return false;
    if (!(await this.subscriptions.hasFeature(user.deviceId, feature, user.businessId))) {
      throw new HttpException(
        { code: 'PREMIUM_REQUIRED', feature, message: 'This feature requires an active Premium subscription on this device. Your local data is not affected.' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
