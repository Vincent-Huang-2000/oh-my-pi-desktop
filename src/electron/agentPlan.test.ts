import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./state.js', () => ({
  addLog: vi.fn(),
}));

import {
  getAcpPlanProposal,
  isAcpPlanApprovalElicitation,
  readFullPlanForApproval,
  readHistoricalSessionPlans,
  resolveHistoricalPlanPath,
  resolveSessionLocalRoot,
} from './agentPlan.js';
import type { AcpProcessState } from './agentTypes.js';
import type { AgentEvent } from './types.js';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createPlanSession = async (acpSessionId = 'acp-plan') => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'omp-desktop-agent-plan-'));
  temporaryRoots.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const localDir = path.join(agentDir, 'sessions', 'project', `session_${acpSessionId}`, 'local');
  await mkdir(localDir, { recursive: true });
  return {
    localDir,
    process: { localSessionId: 'desktop-plan', acpSessionId } as AcpProcessState,
  };
};

describe('xd://propose payload parsing', () => {
  it('识别当前 ACP 的 start 与 xdev result，并拒绝旧 resolve 和畸形 envelope', () => {
    expect(
      getAcpPlanProposal({
        toolCallId: 'proposal-start',
        rawInput: { path: 'xd://propose', content: 'auth' },
      }),
    ).toEqual({ toolCallId: 'proposal-start', title: 'auth' });

    expect(
      getAcpPlanProposal({
        toolCallId: 'proposal-end',
        rawOutput: {
          details: {
            xdev: {
              tool: 'propose',
              mode: 'execute',
              inner: {
                planFilePath: 'local://auth-plan.md',
                title: 'auth',
                planExists: true,
              },
            },
          },
        },
      }),
    ).toEqual({
      toolCallId: 'proposal-end',
      title: 'auth',
      planFilePath: 'local://auth-plan.md',
      planExists: true,
    });

    expect(
      getAcpPlanProposal({
        toolCallId: 'legacy-resolve',
        title: 'resolve',
        rawInput: { action: 'apply' },
        rawOutput: { details: { planFilePath: 'local://auth-plan.md', planExists: true } },
      }),
    ).toBeNull();
    expect(
      getAcpPlanProposal({
        toolCallId: 'bad-result',
        rawOutput: { details: { xdev: { tool: 'propose', mode: 'execute', inner: {} } } },
      }),
    ).toBeNull();
  });

  it('只接受 upstream 当前的 Plan 审批表单文案', () => {
    expect(
      isAcpPlanApprovalElicitation('Approve plan "auth" and start implementation?\n\n# Auth'),
    ).toBe(true);
    expect(isAcpPlanApprovalElicitation('Approve plan "auth"?\n\n# Auth')).toBe(false);
    expect(isAcpPlanApprovalElicitation('Allow tool: bash\n\n# Auth')).toBe(false);
  });
});

describe('plan file resolution', () => {
  it('优先读取 proposal 标题对应的文件，而不是较新的旧计划', async () => {
    const { localDir, process: planProcess } = await createPlanSession();
    await writeFile(path.join(localDir, 'auth-plan.md'), '# Auth\n\n当前方案');
    await writeFile(path.join(localDir, 'stale-plan.md'), '# Stale\n\n旧方案');

    await expect(
      readFullPlanForApproval(planProcess, { toolCallId: 'proposal', title: 'auth' }),
    ).resolves.toEqual({
      planFilePath: 'local://auth-plan.md',
      content: '# Auth\n\n当前方案',
    });
  });

  it('在标题无法复原时接受 ACP 默认的 PLAN.md', async () => {
    const { localDir, process: planProcess } = await createPlanSession();
    await writeFile(path.join(localDir, 'PLAN.md'), '# Default\n\n默认方案');

    await expect(
      readFullPlanForApproval(planProcess, { toolCallId: 'proposal', title: 'missing' }),
    ).resolves.toEqual({
      planFilePath: 'local://PLAN.md',
      content: '# Default\n\n默认方案',
    });
  });

  it('恢复 xdev proposal 历史并拒绝跨 local 根目录的路径', async () => {
    const { localDir, process: planProcess } = await createPlanSession();
    await writeFile(path.join(localDir, 'auth-plan.md'), '# Auth\n\n已提交方案');
    const replayEvents: AgentEvent[] = [
      {
        sessionId: 'desktop-plan',
        type: 'tool_call',
        message: 'xd://propose',
        payload: {
          update: {
            toolCallId: 'legacy-resolve',
            rawInput: { action: 'apply' },
            rawOutput: { details: { planFilePath: 'local://auth-plan.md', planExists: true } },
          },
        },
      },
      {
        sessionId: 'desktop-plan',
        type: 'tool_call',
        message: 'xd://propose',
        payload: {
          update: {
            toolCallId: 'proposal-1',
            rawOutput: {
              details: {
                xdev: {
                  tool: 'propose',
                  mode: 'execute',
                  inner: {
                    planFilePath: 'local://auth-plan.md',
                    title: 'auth',
                    planExists: true,
                  },
                },
              },
            },
          },
        },
      },
    ];

    await expect(readHistoricalSessionPlans(planProcess, replayEvents)).resolves.toEqual([
      {
        id: 'history-plan-proposal-1',
        toolCallId: 'proposal-1',
        planFilePath: 'local://auth-plan.md',
        content: '# Auth\n\n已提交方案',
      },
    ]);
    expect(resolveHistoricalPlanPath(localDir, 'local://PLAN.md')).toBe(
      path.join(localDir, 'PLAN.md'),
    );
    expect(resolveHistoricalPlanPath(localDir, 'local://nested/plan.md')).toBeNull();
    expect(resolveHistoricalPlanPath(localDir, 'local://nested\\plan.md')).toBeNull();
  });

  it('在 Windows 长 artifact 路径下使用 upstream 的短 local 根目录', () => {
    const temporaryDirectory = path.join(tmpdir(), 'omp-desktop-short-root');
    const longArtifactsDir = path.join(tmpdir(), 'x'.repeat(200));

    expect(
      resolveSessionLocalRoot(longArtifactsDir, 'acp/session', 'win32', temporaryDirectory),
    ).toBe(path.join(temporaryDirectory, 'omp-local', 'acp_session'));
    expect(
      resolveSessionLocalRoot(
        path.join(tmpdir(), 'short-artifacts'),
        'acp-session',
        'win32',
        temporaryDirectory,
      ),
    ).toBe(path.resolve(path.join(tmpdir(), 'short-artifacts'), 'local'));
  });
});
