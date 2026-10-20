import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClientIp, CurrentUser, Permissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Permissions('users.manage')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.users.list(u); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateUserDto, @ClientIp() ip?: string) { return this.users.create(u, dto, ip); }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @ClientIp() ip?: string) { return this.users.update(u, id, dto, ip); }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) { return this.users.deactivate(u, id, ip); }
}

@Module({ controllers: [UsersController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
