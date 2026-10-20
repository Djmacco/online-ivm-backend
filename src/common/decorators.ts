import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission } from '../rbac/permissions';
import { FeatureName } from './features';
import { AuthUser } from './types';

export const IS_PUBLIC = 'isPublic';
export const DEVICE_TOKEN_OK = 'deviceTokenOk';
export const OPTIONAL_AUTH = 'optionalAuth';
export const PERMISSIONS_KEY = 'permissions';
export const FEATURE_KEY = 'feature';

/** No authentication at all (login, register, payment start, webhook, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Accept a device token (issued when a device starts a payment) as well as an account JWT. */
export const AllowDeviceToken = () => SetMetadata(DEVICE_TOKEN_OK, true);
/** Credentials are optional (the handler authorises by itself, e.g. by the unguessable payment reference). A token that IS sent must be valid. */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);
/** The caller must hold ALL listed permissions. */
export const Permissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);
/** The calling DEVICE must hold an active Premium subscription for this feature (server-side enforcement). */
export const RequireFeature = (feature: FeatureName) => SetMetadata(FEATURE_KEY, feature);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => ctx.switchToHttp().getRequest().ip);
