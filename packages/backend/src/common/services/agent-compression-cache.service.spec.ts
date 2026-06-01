import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentCompressionCacheService } from './agent-compression-cache.service';
import { Agent } from '../../entities/agent.entity';

describe('AgentCompressionCacheService', () => {
  let service: AgentCompressionCacheService;
  let mockFindOne: jest.Mock;

  beforeEach(async () => {
    mockFindOne = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentCompressionCacheService,
        { provide: getRepositoryToken(Agent), useValue: { findOne: mockFindOne } },
      ],
    }).compile();
    service = module.get(AgentCompressionCacheService);
  });

  it('returns defaults without a DB hit when agentId is falsy', async () => {
    await expect(service.getCompressionFlags(undefined)).resolves.toEqual({
      compress_prompt: false,
      compress_tool_output: false,
      compress_response: false,
    });
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('loads all compression flags from the agent row', async () => {
    mockFindOne.mockResolvedValue({
      id: 'a-1',
      compress_prompt: true,
      compress_tool_output: false,
      compress_response: true,
    });
    await expect(service.getCompressionFlags('a-1')).resolves.toEqual({
      compress_prompt: true,
      compress_tool_output: false,
      compress_response: true,
    });
    expect(mockFindOne).toHaveBeenCalledWith({
      where: { id: 'a-1' },
      select: ['id', 'compress_prompt', 'compress_tool_output', 'compress_response'],
    });
  });

  it('returns false when compress_response is disabled', async () => {
    mockFindOne.mockResolvedValue({
      id: 'a-1',
      compress_prompt: false,
      compress_tool_output: false,
      compress_response: false,
    });
    expect(await service.isResponseCompressionEnabled('a-1')).toBe(false);
  });

  it('returns true when compress_response is enabled', async () => {
    mockFindOne.mockResolvedValue({
      id: 'a-2',
      compress_prompt: false,
      compress_tool_output: false,
      compress_response: true,
    });
    expect(await service.isResponseCompressionEnabled('a-2')).toBe(true);
  });

  it('returns true when compress_prompt is enabled', async () => {
    mockFindOne.mockResolvedValue({
      id: 'a-2b',
      compress_prompt: true,
      compress_tool_output: false,
      compress_response: false,
    });
    expect(await service.isPromptCompressionEnabled('a-2b')).toBe(true);
  });

  it('returns true when compress_tool_output is enabled', async () => {
    mockFindOne.mockResolvedValue({
      id: 'a-2c',
      compress_prompt: false,
      compress_tool_output: true,
      compress_response: false,
    });
    expect(await service.isToolOutputCompressionEnabled('a-2c')).toBe(true);
  });

  it('returns false when the agent is missing entirely', async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await service.isResponseCompressionEnabled('missing')).toBe(false);
    expect(await service.isPromptCompressionEnabled('missing')).toBe(false);
  });

  it('caches subsequent lookups', async () => {
    mockFindOne.mockResolvedValue({
      id: 'a-3',
      compress_prompt: true,
      compress_tool_output: false,
      compress_response: true,
    });
    expect(await service.isResponseCompressionEnabled('a-3')).toBe(true);
    expect(await service.isPromptCompressionEnabled('a-3')).toBe(true);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after invalidation', async () => {
    mockFindOne.mockResolvedValueOnce({
      id: 'a-4',
      compress_prompt: true,
      compress_tool_output: false,
      compress_response: true,
    });
    expect(await service.isResponseCompressionEnabled('a-4')).toBe(true);
    service.invalidate('a-4');
    mockFindOne.mockResolvedValueOnce({
      id: 'a-4',
      compress_prompt: false,
      compress_tool_output: false,
      compress_response: false,
    });
    expect(await service.isResponseCompressionEnabled('a-4')).toBe(false);
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });
});
