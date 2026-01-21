import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Admin } from './entities/admin.entity';
import { RevokedToken } from './entities/revoked-token.entity';
import { LoginDto } from './dto/login.dto';

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

    const payload = { sub: admin.uid, email: admin.email };
    return {
      admin: {
        email: admin.email,
        full_name: admin.fullName,
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

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
