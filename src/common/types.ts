import { RoleName } from '../rbac/permissions';

/** Who is calling. `account` = cloud account (JWT). `device` = a paid device identified by its device token. */
export interface AuthUser {
  kind: 'account' | 'device';
  id: string;
  /** Empty string for device principals (no account / business). */
  businessId: string;
  email: string;
  fullName: string;
  role: RoleName;
  deviceId: string;
  permissions: string[];
}
