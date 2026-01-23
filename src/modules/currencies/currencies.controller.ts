import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CurrenciesService } from './currencies.service';
import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@ApiTags('Currencies')
@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currenciesService: CurrenciesService) {}

  @Post()
  @AdminAuth()
  @ApiOperation({ summary: 'Crear una nueva divisa' })
  @ApiBearerAuth('JWT-auth')
  @ApiResponse({
    status: 201,
    description: 'Divisa creada exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  create(@Body() createDto: CreateCurrencyDto) {
    return this.currenciesService.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todas las divisas' })
  @ApiResponse({
    status: 200,
    description: 'Lista de divisas obtenida exitosamente',
  })
  findAll() {
    return this.currenciesService.findAll();
  }

  @Get(':uid')
  @ApiOperation({ summary: 'Obtener una divisa por su UID' })
  @ApiParam({
    name: 'uid',
    description: 'UID de la divisa',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Divisa encontrada',
  })
  @ApiResponse({ status: 404, description: 'Divisa no encontrada' })
  findOne(@Param('uid') uid: string) {
    return this.currenciesService.findOne(uid);
  }

  @Patch(':uid')
  @AdminAuth()
  @ApiOperation({ summary: 'Actualizar una divisa existente' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la divisa a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Divisa actualizada exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Divisa no encontrada' })
  update(@Param('uid') uid: string, @Body() updateDto: UpdateCurrencyDto) {
    return this.currenciesService.update(uid, updateDto);
  }

  @Delete(':uid')
  @AdminAuth()
  @ApiOperation({ summary: 'Eliminar una divisa' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la divisa a eliminar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Divisa eliminada exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Divisa no encontrada' })
  remove(@Param('uid') uid: string) {
    return this.currenciesService.remove(uid);
  }
}
