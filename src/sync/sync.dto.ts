import { Type } from 'class-transformer';
import { Allow, ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsString, Length, Matches, Min, ValidateNested } from 'class-validator';
import { DEVICE_ID_RULE } from '../auth/auth.dto';

export class ChangeDto {
  /** sync_queue.id – idempotency key. */
  @IsString() @Length(1, 100) opId: string;
  @IsString() @Length(1, 60) entityType: string;
  @IsString() @Length(1, 100) entityId: string;
  @IsIn(['CREATE', 'UPDATE', 'DELETE']) operation: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Server version this edit was based on (0 for a brand-new record). */
  @IsInt() @Min(0) baseVersion: number;
  @IsObject() data: Record<string, any>;
}

export class PushDto {
  @Matches(DEVICE_ID_RULE) deviceId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ChangeDto) changes: ChangeDto[];
}

export class PullQueryDto {
  @Allow() since?: string;
  @Allow() deviceId?: string;
  @Allow() limit?: string;
}

export class RestoreQueryDto {
  @Allow() after?: string;
  @Allow() deviceId?: string;
  @Allow() limit?: string;
}
