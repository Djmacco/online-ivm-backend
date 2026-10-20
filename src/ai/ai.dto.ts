import { Type } from 'class-transformer';
import { Allow, ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** Contract (desktop): POST /ai/store-scan { image: <base64>, mime, lang } → { detections }. Matching to inventory happens on the desktop. */
export class StoreScanDto {
  /** Raw base64 (no data: prefix). ≤ ~5 MB image. */
  @IsString() @MaxLength(7_500_000) image: string;
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'image/gif']) mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  @IsOptional() @IsString() @MaxLength(5) lang?: string;
}

export class AssistantMessageDto {
  @IsIn(['user', 'assistant']) role: 'user' | 'assistant';
  /** string, or content blocks of type text | tool_use | tool_result. */
  @Allow() content: string | Array<Record<string, any>>;
}

export class AssistantToolDto {
  @IsString() @Length(1, 64) name: string;
  @IsString() @MaxLength(1000) description: string;
  @IsObject() input_schema: Record<string, any>;
}

export class AssistantExecuteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => AssistantMessageDto) messages: AssistantMessageDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => AssistantToolDto) tools?: AssistantToolDto[];
  /** Extra app context (current screen, currency…). Appended after the server's fixed safety prompt. */
  @IsOptional() @IsString() @MaxLength(4000) context?: string;
  @IsOptional() @IsIn(['fr', 'en']) language?: 'fr' | 'en';
  @IsOptional() @IsInt() @Min(64) @Max(2000) maxTokens?: number;
}
