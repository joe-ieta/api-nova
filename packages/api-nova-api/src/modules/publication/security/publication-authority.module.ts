import { Module } from '@nestjs/common';
import { PublicationHostAuthorityService } from './publication-host-authority.service';

/** Imported by both consumers: Nest shares one issuer and request-binding store. */
@Module({ providers: [PublicationHostAuthorityService], exports: [PublicationHostAuthorityService] })
export class PublicationAuthorityModule {}
