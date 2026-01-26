import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger configuration - Solo en desarrollo
  if (process.env.NODE_ENV !== 'production') {
    try {
      const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');

      const config = new DocumentBuilder()
        .setTitle('Raffles API')
        .setDescription('Documentación de la API para el sistema de rifas')
        .setVersion('1.0')
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            name: 'JWT',
            description: 'Enter JWT token',
            in: 'header',
          },
          'JWT-auth',
        )
        .addTag('api/v1')
        .build();

      const document = SwaggerModule.createDocument(app, config);
      SwaggerModule.setup('api', app, document);
    } catch (error) {
      // Swagger no disponible en producción, ignorar error
      console.log('Swagger no disponible en este entorno');
    }
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
