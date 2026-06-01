import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { TtlFifoCache } from '../utils/ttl-fifo-cache';

export type AgentCompressionFlags = {
  compress_prompt: boolean;
  compress_tool_output: boolean;
  compress_response: boolean;
};

const DEFAULT_FLAGS: AgentCompressionFlags = {
  compress_prompt: false,
  compress_tool_output: false,
  compress_response: false,
};

@Injectable()
export class AgentCompressionCacheService {
  private readonly cache = new TtlFifoCache<string, AgentCompressionFlags>({
    maxEntries: 5_000,
    ttlMs: 60_000,
  });

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
  ) {}

  async getCompressionFlags(agentId: string | null | undefined): Promise<AgentCompressionFlags> {
    if (!agentId) return DEFAULT_FLAGS;
    return this.cache.resolve(agentId, async (id) => {
      const agent = await this.agentRepo.findOne({
        where: { id },
        select: ['id', 'compress_prompt', 'compress_tool_output', 'compress_response'],
      });
      if (!agent) return DEFAULT_FLAGS;
      return {
        compress_prompt: agent.compress_prompt === true,
        compress_tool_output: agent.compress_tool_output === true,
        compress_response: agent.compress_response === true,
      };
    });
  }

  async isPromptCompressionEnabled(agentId: string | null | undefined): Promise<boolean> {
    return (await this.getCompressionFlags(agentId)).compress_prompt;
  }

  async isResponseCompressionEnabled(agentId: string | null | undefined): Promise<boolean> {
    return (await this.getCompressionFlags(agentId)).compress_response;
  }

  async isToolOutputCompressionEnabled(agentId: string | null | undefined): Promise<boolean> {
    return (await this.getCompressionFlags(agentId)).compress_tool_output;
  }

  invalidate(agentId: string): void {
    this.cache.invalidate(agentId);
  }
}
