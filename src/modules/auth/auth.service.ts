import { Injectable, UnauthorizedException, ConflictException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Admin } from './entities/admin.entity';
import { RevokedToken } from './entities/revoked-token.entity';
import { LoginDto } from './dto/login.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { AdminRole } from './enums/admin-role.enum';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Admin)
    private adminRepository: Repository<Admin>,
    @InjectRepository(RevokedToken)
    private revokedTokenRepository: Repository<RevokedToken>,
    private jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const admin = await this.adminRepository.findOne({ where: { email } });

    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: admin.uid, email: admin.email, role: admin.role };
    return {
      admin: {
        email: admin.email,
        full_name: admin.fullName,
        role: admin.role,
      },
      token: this.jwtService.sign(payload),
    };
  }

  async logout(token: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token) as { exp?: number };
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000); // Default 1 day if no exp

    const revokedToken = this.revokedTokenRepository.create({
      tokenHash,
      expiresAt,
    });

    await this.revokedTokenRepository.save(revokedToken);
  }

  async isTokenRevoked(token: string): Promise<boolean> {
    const tokenHash = this.hashToken(token);
    const revoked = await this.revokedTokenRepository.findOne({
      where: { tokenHash },
    });
    return !!revoked;
  }

  async createAdmin(createAdminDto: CreateAdminDto): Promise<Omit<Admin, 'passwordHash' | 'fullName'> & { full_name: string }> {
    const { email, password, fullName, role } = createAdminDto;

    // Check if admin with this email already exists
    const existingAdmin = await this.adminRepository.findOne({ where: { email } });
    if (existingAdmin) {
      throw new ConflictException('An admin with this email already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create and save admin
    const admin = this.adminRepository.create({
      email,
      passwordHash,
      fullName,
      role: role || AdminRole.VERIFIER,
    });

    const savedAdmin = await this.adminRepository.save(admin);

    // Return admin without password hash, with full_name in snake_case
    const { passwordHash: _, fullName: adminFullName, ...rest } = savedAdmin;
    return {
      ...rest,
      full_name: adminFullName,
    };
  }

  async findAll(): Promise<Array<Omit<Admin, 'passwordHash' | 'fullName'> & { full_name: string }>> {
    const admins = await this.adminRepository.find({
      order: { createdAt: 'DESC' },
    });

    return admins.map((admin) => {
      const { passwordHash: _, fullName: adminFullName, ...rest } = admin;
      return {
        ...rest,
        full_name: adminFullName,
      };
    });
  }

  async findOne(uid: string): Promise<Omit<Admin, 'passwordHash' | 'fullName'> & { full_name: string }> {
    const admin = await this.adminRepository.findOne({ where: { uid } });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    const { passwordHash: _, fullName: adminFullName, ...rest } = admin;
    return {
      ...rest,
      full_name: adminFullName,
    };
  }

  async update(uid: string, updateAdminDto: UpdateAdminDto): Promise<Omit<Admin, 'passwordHash' | 'fullName'> & { full_name: string }> {
    const admin = await this.adminRepository.findOne({ where: { uid } });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    // Check if email is being updated and if it's already in use
    if (updateAdminDto.email && updateAdminDto.email !== admin.email) {
      const existingAdmin = await this.adminRepository.findOne({
        where: { email: updateAdminDto.email },
      });
      if (existingAdmin) {
        throw new ConflictException('An admin with this email already exists');
      }
      admin.email = updateAdminDto.email;
    }

    // Update fullName if provided
    if (updateAdminDto.fullName !== undefined) {
      admin.fullName = updateAdminDto.fullName;
    }

    // Update role if provided
    if (updateAdminDto.role !== undefined) {
      admin.role = updateAdminDto.role;
    }

    // Update password if provided
    if (updateAdminDto.password) {
      admin.passwordHash = await bcrypt.hash(updateAdminDto.password, 10);
    }

    const updatedAdmin = await this.adminRepository.save(admin);

    const { passwordHash: _, fullName: adminFullName, ...rest } = updatedAdmin;
    return {
      ...rest,
      full_name: adminFullName,
    } as Omit<Admin, 'passwordHash' | 'fullName'> & { full_name: string };
  }

  async remove(uid: string): Promise<void> {
    const admin = await this.adminRepository.findOne({ where: { uid } });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    await this.adminRepository.remove(admin);
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
