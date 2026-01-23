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
import { PaymentMethodsService } from './payment-methods.service';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';
import { ApiFile } from '../../common/decorators/api-file.decorator';

@ApiTags('Payment Methods')
@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post()
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Crear un nuevo método de pago' })
  @ApiBearerAuth('JWT-auth')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreatePaymentMethodDto })
  @ApiFile('image', false)
  @ApiResponse({
    status: 201,
    description: 'Método de pago creado exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  create(
    @Body() createDto: CreatePaymentMethodDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Handle JSON parsing for multipart form data
    if (createDto.payment_data && typeof createDto.payment_data === 'string') {
      try {
        const parsed: unknown = JSON.parse(createDto.payment_data);
        createDto.payment_data = parsed;
      } catch {
        // ignore
      }
    }
    return this.paymentMethodsService.createWithImage(createDto, file);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todos los métodos de pago' })
  @ApiResponse({
    status: 200,
    description: 'Lista de métodos de pago obtenida exitosamente',
  })
  findAll() {
    return this.paymentMethodsService.findAll();
  }

  @Get(':uid')
  @ApiOperation({ summary: 'Obtener un método de pago por su UID' })
  @ApiParam({
    name: 'uid',
    description: 'UID del método de pago',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Método de pago encontrado',
  })
  @ApiResponse({ status: 404, description: 'Método de pago no encontrado' })
  findOne(@Param('uid') uid: string) {
    return this.paymentMethodsService.findOne(uid);
  }

  @Put(':uid')
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Actualizar un método de pago existente' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del método de pago a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdatePaymentMethodDto })
  @ApiFile('image', false)
  @ApiResponse({
    status: 200,
    description: 'Método de pago actualizado exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Método de pago no encontrado' })
  update(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePaymentMethodDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (updateDto.payment_data && typeof updateDto.payment_data === 'string') {
      try {
        const parsed: unknown = JSON.parse(updateDto.payment_data);
        updateDto.payment_data = parsed;
      } catch {
        // ignore
      }
    }
    return this.paymentMethodsService.updateWithImage(uid, updateDto, file);
  }

  @Delete(':uid')
  @AdminAuth()
  @ApiOperation({ summary: 'Eliminar un método de pago' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del método de pago a eliminar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Método de pago eliminado exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Método de pago no encontrado' })
  remove(@Param('uid') uid: string) {
    return this.paymentMethodsService.remove(uid);
  }
}
