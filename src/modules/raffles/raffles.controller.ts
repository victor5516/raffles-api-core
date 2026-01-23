import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { RafflesService } from './raffles.service';
import { CreateRaffleDto } from './dto/create-raffle.dto';
import { UpdateRaffleDto } from './dto/update-raffle.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request } from 'express';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';
import { Admin } from '../auth/entities/admin.entity';
import { ApiFile } from '../../common/decorators/api-file.decorator';

type AuthenticatedRequest = Request & { user: Admin };

@ApiTags('Raffles')
@Controller('raffles')
export class RafflesController {
  constructor(private readonly rafflesService: RafflesService) {}

  @Post()
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Crear una nueva rifa' })
  @ApiBearerAuth('JWT-auth')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateRaffleDto })
  @ApiFile('image', false)
  @ApiResponse({
    status: 201,
    description: 'Rifa creada exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  async create(
    @Body() createRaffleDto: CreateRaffleDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.rafflesService.createWithImage(createRaffleDto, file);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todas las rifas' })
  @ApiResponse({
    status: 200,
    description: 'Lista de rifas obtenida exitosamente',
  })
  findAll() {
    return this.rafflesService.findAllEfficient();
  }

  @Get(':uid')
  @ApiOperation({ summary: 'Obtener una rifa por su UID' })
  @ApiParam({
    name: 'uid',
    description: 'UID de la rifa',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Rifa encontrada',
  })
  @ApiResponse({ status: 404, description: 'Rifa no encontrada' })
  findOne(@Param('uid') uid: string) {
    return this.rafflesService.findOne(uid);
  }

  @Put(':uid')
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Actualizar una rifa existente' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la rifa a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateRaffleDto })
  @ApiFile('image', false)
  @ApiResponse({
    status: 200,
    description: 'Rifa actualizada exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Rifa no encontrada' })
  async update(
    @Param('uid') uid: string,
    @Body() updateRaffleDto: UpdateRaffleDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.rafflesService.updateWithImage(
      uid,
      updateRaffleDto,
      file,
      req.user?.uid,
    );
  }

  @Delete(':uid')
  @AdminAuth()
  @ApiOperation({ summary: 'Eliminar una rifa' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la rifa a eliminar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Rifa eliminada exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Rifa no encontrada' })
  remove(@Param('uid') uid: string) {
    return this.rafflesService.remove(uid);
  }
}
