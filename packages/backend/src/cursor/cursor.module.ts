import { Module } from '@nestjs/common';
import { CursorProxyService } from './cursor-proxy.service';

@Module({
  providers: [CursorProxyService],
  exports: [CursorProxyService],
})
export class CursorModule {}
