import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';
import { CreateSpinPrizeDto } from './dto/create-spin-prize.dto';
import { UpdateSpinPrizeDto } from './dto/update-spin-prize.dto';
import { SpinPrizesService } from './services/spin-prizes.service';

@ApiTags('Spin Prizes Admin')
@ApiBearerAuth('JWT-auth')
@AdminAuth()
@Controller('admin/spin-prizes')
export class SpinPrizesAdminController {
  constructor(private readonly spinPrizesService: SpinPrizesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar premios de ruleta' })
  findAll() {
    return this.spinPrizesService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Crear premio de ruleta' })
  @ApiResponse({ status: 201, description: 'Premio creado correctamente' })
  create(@Body() dto: CreateSpinPrizeDto) {
    return this.spinPrizesService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar premio de ruleta' })
  update(@Param('id') id: string, @Body() dto: UpdateSpinPrizeDto) {
    return this.spinPrizesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Desactivar premio de ruleta' })
  remove(@Param('id') id: string) {
    return this.spinPrizesService.remove(id);
  }
}
