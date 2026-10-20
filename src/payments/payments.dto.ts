import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { DEVICE_ID_RULE } from '../auth/auth.dto';

export class CreatePaymentDto {
  @IsIn(['PREMIUM']) plan: 'PREMIUM';
  @IsIn(['MTN_MOMO', 'ORANGE_MONEY']) provider: 'MTN_MOMO' | 'ORANGE_MONEY';
  /** Already normalised by the app: 237 + 9 digits. Also tolerates +237 / spaces. */
  @IsString() @MaxLength(20) phone: string;
  @Matches(DEVICE_ID_RULE, { message: 'deviceId is invalid' }) deviceId: string;
}
