import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { Auth } from './decorators/admin-auth.decorator';
import { AdminRole } from './enums/admin-role.enum';

@ApiTags('Authentication')
@Controller('admins')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión como administrador' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Login exitoso, retorna token JWT',
    schema: {
      type: 'object',
      properties: {
        access_token: {
          type: 'string',
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Auth()
  @ApiOperation({ summary: 'Cerrar sesión (revocar token)' })
  @ApiBearerAuth('JWT-auth')
  @ApiResponse({
    status: 200,
    description: 'Logout exitoso',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Logged out successfully',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  async logout(@Headers('authorization') authHeader: string) {
    const token = authHeader?.replace('Bearer ', '');
    if (token) {
      await this.authService.logout(token);
    }
    return { message: 'Logged out successfully' };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Crear un nuevo administrador o verificador (solo Super Admin)' })
  @ApiBearerAuth('JWT-auth')
  @ApiBody({ type: CreateAdminDto })
  @ApiResponse({
    status: 201,
    description: 'Administrador creado exitosamente',
    schema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        email: {
          type: 'string',
          example: 'admin@example.com',
        },
        fullName: {
          type: 'string',
          example: 'Juan Pérez',
        },
        role: {
          type: 'string',
          enum: ['super_admin', 'verifier'],
          example: 'verifier',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin puede crear administradores' })
  @ApiResponse({ status: 409, description: 'El email ya está en uso' })
  async createAdmin(@Body() createAdminDto: CreateAdminDto) {
    return this.authService.createAdmin(createAdminDto);
  }

  @Get()
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Obtener todos los administradores (solo Super Admin)' })
  @ApiBearerAuth('JWT-auth')
  @ApiResponse({
    status: 200,
    description: 'Lista de administradores obtenida exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin puede ver administradores' })
  async findAll() {
    return this.authService.findAll();
  }

  @Get(':uid')
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Obtener un administrador por UID (solo Super Admin)' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del administrador',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Administrador encontrado',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin puede ver administradores' })
  @ApiResponse({ status: 404, description: 'Administrador no encontrado' })
  async findOne(@Param('uid') uid: string) {
    return this.authService.findOne(uid);
  }

  @Patch(':uid')
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Actualizar un administrador (solo Super Admin)' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del administrador a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({ type: UpdateAdminDto })
  @ApiResponse({
    status: 200,
    description: 'Administrador actualizado exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin puede actualizar administradores' })
  @ApiResponse({ status: 404, description: 'Administrador no encontrado' })
  @ApiResponse({ status: 409, description: 'El email ya está en uso' })
  async update(@Param('uid') uid: string, @Body() updateAdminDto: UpdateAdminDto) {
    return this.authService.update(uid, updateAdminDto);
  }

  @Delete(':uid')
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Eliminar un administrador (solo Super Admin)' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del administrador a eliminar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Administrador eliminado exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin puede eliminar administradores' })
  @ApiResponse({ status: 404, description: 'Administrador no encontrado' })
  async remove(@Param('uid') uid: string) {
    await this.authService.remove(uid);
    return { message: 'Admin deleted successfully' };
  }
}
