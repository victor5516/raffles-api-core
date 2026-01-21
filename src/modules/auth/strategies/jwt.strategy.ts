import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { Admin } from '../entities/admin.entity';
import { AuthService } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(Admin)
    private adminRepository: Repository<Admin>,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: { sub: string }) {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);

    if (token && (await this.authService.isTokenRevoked(token))) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const { sub: uid } = payload;
    const admin = await this.adminRepository.findOne({ where: { uid } });
    if (!admin) {
      throw new UnauthorizedException();
    }
    return admin;
  }
}
