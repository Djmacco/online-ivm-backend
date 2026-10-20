import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsString, MaxLength } from 'class-validator';

export class ShareDevicesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(9)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  deviceIds!: string[];
}
