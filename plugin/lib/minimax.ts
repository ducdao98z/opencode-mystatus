/**
 * MiniMax Coding Plan 额度查询模块
 *
 * [输入]: Session cookie from ~/.config/opencode/minimax-session.json
 * [输出]: 格式化的额度使用情况
 * [定位]: 被 mystatus.ts 调用，处理 MiniMax Coding Plan 账号
 * [同步]: mystatus.ts, types.ts, utils.ts, i18n.ts
 *
 * NOTE: MiniMax quota API requires cookie auth (HERTZ-SESSION),
 * not API key auth. Users need to provide session cookie.
 */

import { t } from "./i18n";
import {
  type QueryResult,
  type MiniMaxAuthData,
  HIGH_USAGE_THRESHOLD,
} from "./types";
import {
  formatDuration,
  createProgressBar,
  calcRemainPercent,
  fetchWithTimeout,
  maskString,
} from "./utils";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// 类型定义 (best-guess based on MiniMax Coding Plan FAQ)
// ============================================================================

/**
 * MiniMax /coding_plan/remains response envelope.
 * API: GET https://platform.minimaxi.io/v1/api/openplatform/coding_plan/remains
 */
interface MiniMaxRemainsResponse {
  base_resp: {
    status_code: number;
    status_msg: string;
  };
  data?: {
    /** Plan name, e.g. "Starter", "Plus", "Max" */
    plan_name?: string;
    /** Total prompts allowed per 5h window */
    total_prompts: number;
    /** Prompts used in current 5h window */
    used_prompts: number;
    /** Prompts remaining in current 5h window */
    remaining_prompts: number;
    /** Next reset timestamp in ms (rolling window) */
    next_reset_time: number;
    /** Usage percentage (0-100) */
    usage_percentage: number;
  };
}

// ============================================================================
// 配置
// ============================================================================

const MINIMAX_QUOTA_URL =
  "https://platform.minimaxi.io/v1/api/openplatform/coding_plan/remains";

interface MiniMaxSessionConfig {
  session: string;
}

// ============================================================================
// 配置读取
// ============================================================================

/**
 * 读取 MiniMax session cookie
 * 从 ~/.config/opencode/minimax-session.json
 */
async function loadMiniMaxSession(): Promise<string | null> {
  const configPath = join(homedir(), ".config/opencode/minimax-session.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content) as MiniMaxSessionConfig;
    return config.session || null;
  } catch {
    return null;
  }
}

// ============================================================================
// API 调用
// ============================================================================

/**
 * 获取 MiniMax Coding Plan 使用情况
 */
async function fetchMiniMaxUsage(
  session: string,
): Promise<MiniMaxRemainsResponse> {
  const response = await fetchWithTimeout(MINIMAX_QUOTA_URL, {
    method: "GET",
    headers: {
      Cookie: `HERTZ-SESSION=${session}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenCode-Status-Plugin/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(t.minimaxApiError(response.status, errorText));
  }

  const data = (await response.json()) as MiniMaxRemainsResponse;

  if (data.base_resp.status_code !== 0) {
    throw new Error(
      t.minimaxApiError(
        data.base_resp.status_code,
        data.base_resp.status_msg || "Unknown error",
      ),
    );
  }

  return data;
}

// ============================================================================
// 格式化输出
// ============================================================================

/**
 * 格式化 MiniMax 使用情况
 */
function formatMiniMaxUsage(
  resp: MiniMaxRemainsResponse,
  session: string,
): string {
  const lines: string[] = [];
  const d = resp.data;

  // 标题行：Account: masked session (Plan)
  const maskedSession = maskString(session, 8);
  const planLabel = d?.plan_name
    ? `Coding Plan - ${d.plan_name}`
    : "Coding Plan";
  lines.push(`${t.account}        ${maskedSession} (${planLabel})`);
  lines.push("");

  // 如果 data 为空或缺少关键字段
  if (!d || (d.total_prompts == null && d.remaining_prompts == null)) {
    lines.push(t.noQuotaData);
    return lines.join("\n");
  }

  // 计算使用情况
  const total = d.total_prompts ?? 0;
  const used = d.used_prompts ?? total - (d.remaining_prompts ?? total);
  const remaining = d.remaining_prompts ?? total - used;
  const usagePercent =
    d.usage_percentage ?? (total > 0 ? (used / total) * 100 : 0);
  const remainPercent = calcRemainPercent(usagePercent);

  // Prompt 限额
  const progressBar = createProgressBar(remainPercent);
  lines.push(t.minimaxPromptLimit);
  lines.push(`${progressBar} ${t.remaining(remainPercent)}`);
  lines.push(`${t.used}: ${used} / ${total} prompts`);

  // 重置时间
  if (d.next_reset_time) {
    const resetSeconds = Math.max(
      0,
      Math.floor((d.next_reset_time - Date.now()) / 1000),
    );
    lines.push(t.resetIn(formatDuration(resetSeconds)));
  }

  // 高使用率警告
  if (usagePercent >= HIGH_USAGE_THRESHOLD) {
    lines.push("");
    lines.push(t.limitReached);
  }

  return lines.join("\n");
}

// ============================================================================
// 导出接口
// ============================================================================

/**
 * 查询 MiniMax Coding Plan 额度
 * @param authData MiniMax 认证数据 (currently unused - requires session cookie)
 * @returns 查询结果，如果账号不存在或无效返回 null
 *
 * NOTE: MiniMax quota API requires HERTZ-SESSION cookie.
 * Users must create ~/.config/opencode/minimax-session.json:
 *   {"session": "MTc3MTA2NDA0Nnx..."}
 */
export async function queryMiniMaxUsage(
  _authData: MiniMaxAuthData | undefined,
): Promise<QueryResult | null> {
  const session = await loadMiniMaxSession();

  if (!session) {
    return {
      success: false,
      error: t.minimaxConfigRequired,
    };
  }

  try {
    const usage = await fetchMiniMaxUsage(session);
    return {
      success: true,
      output: formatMiniMaxUsage(usage, session),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
