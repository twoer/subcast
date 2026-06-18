/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Main-process i18n for menus, tray, and native dialogs (Phase 5.1).
 *
 * Why a separate dictionary, not the renderer's vue-i18n: the menu /
 * tray / dialog text is built by Electron before the renderer process
 * even exists. We can't reach into vue-i18n from the main process,
 * and bundling it just for ~30 strings is overkill.
 *
 * Locale selection follows `app.getLocale()` — Electron exposes the
 * user's preferred OS UI language. We map any "zh*" tag to the zh-CN
 * bundle and everything else to en. Adding more locales later means
 * extending `MESSAGES` and the resolver.
 */

import { app } from 'electron';

type Locale = 'en' | 'zh';

interface Bundle {
  tray: {
    show: string;
    quit: string;
    exportDiagnostics: string;
    checkForUpdates: string;
  };
  menu: {
    about: string;
    quit: string;
    documentation: string;
    reportIssue: string;
    exportDiagnostics: string;
    checkForUpdates: string;
  };
  startupFailure: {
    title: string;
    message: string;
    causesIntro: string;
    openLogs: string;
    reportIssue: string;
    quit: string;
  };
  binaryMissing: {
    title: string;
    message: string;
    detailIntro: string; // prepended to the bullet list
    fixHint: string;     // shown below the list
    openLogs: string;
    reportIssue: string;
    quit: string;
  };
  diagnostics: {
    successTitle: string;
    successMessage: string;
    successDetail: string; // {count} {bytes} {path}
    failureTitle: string;
    failureMessage: string;
  };
  updates: {
    upToDateTitle: string;
    upToDateMessage: string; // {version}
    availableTitle: string;
    availableMessage: string; // {latest}
    availableDetail: string;  // {current}
    openDownload: string;
    later: string;
    failedTitle: string;
    failedMessage: string;
  };
}

const EN: Bundle = {
  tray: {
    show: 'Show Subcast',
    quit: 'Quit Subcast',
    exportDiagnostics: 'Export Diagnostics…',
    checkForUpdates: 'Check for Updates…',
  },
  menu: {
    about: 'About Subcast',
    quit: 'Quit Subcast',
    documentation: 'Help',
    reportIssue: 'Report Issue…',
    exportDiagnostics: 'Export Diagnostics…',
    checkForUpdates: 'Check for Updates…',
  },
  startupFailure: {
    title: 'Subcast failed to start',
    message: 'Subcast failed to start',
    causesIntro:
      'Open Log Folder for details, or report this with the latest log file attached.',
    openLogs: 'Open Log Folder',
    reportIssue: 'Report Issue…',
    quit: 'Quit',
  },
  binaryMissing: {
    title: 'Subcast — required components missing',
    message: 'Required bundled binaries are missing or unusable',
    detailIntro:
      'Subcast ships with sidecar binaries that handle audio extraction and speech recognition. The following are unavailable:',
    fixHint:
      'This usually means the install was corrupted or a binary was quarantined by antivirus / Gatekeeper. Reinstalling from the official release page typically fixes this.',
    openLogs: 'Open Log Folder',
    reportIssue: 'Report Issue…',
    quit: 'Quit',
  },
  diagnostics: {
    successTitle: 'Diagnostics exported',
    successMessage: 'Diagnostics zip saved',
    successDetail: 'Saved {count} log file(s) ({bytes} bytes) to:\n{path}',
    failureTitle: 'Export failed',
    failureMessage: 'Could not export diagnostics',
  },
  updates: {
    upToDateTitle: 'Up to date',
    upToDateMessage: 'Subcast {version} is the latest version.',
    availableTitle: 'Update available',
    availableMessage: 'Subcast {latest} is available',
    availableDetail: 'You are on {current}. The release page has download links and notes.',
    openDownload: 'Open Download Page',
    later: 'Later',
    failedTitle: 'Update check failed',
    failedMessage: "Couldn't reach GitHub",
  },
};

const ZH: Bundle = {
  tray: {
    show: '显示 Subcast',
    quit: '退出 Subcast',
    exportDiagnostics: '导出诊断…',
    checkForUpdates: '检查更新…',
  },
  menu: {
    about: '关于 Subcast',
    quit: '退出 Subcast',
    documentation: '帮助',
    reportIssue: '报告问题…',
    exportDiagnostics: '导出诊断…',
    checkForUpdates: '检查更新…',
  },
  startupFailure: {
    title: 'Subcast 启动失败',
    message: 'Subcast 启动失败',
    causesIntro: '打开日志文件夹查看详情，或带上最新的日志文件报告问题。',
    openLogs: '打开日志文件夹',
    reportIssue: '报告问题…',
    quit: '退出',
  },
  binaryMissing: {
    title: 'Subcast — 缺少必需组件',
    message: '缺少必需的内置二进制文件',
    detailIntro:
      'Subcast 依赖随包发布的二进制工具完成音频抽取与语音识别。以下文件不可用：',
    fixHint:
      '这通常说明安装包损坏或文件被杀毒软件 / Gatekeeper 隔离。建议从官方发布页重新下载安装。',
    openLogs: '打开日志文件夹',
    reportIssue: '报告问题…',
    quit: '退出',
  },
  diagnostics: {
    successTitle: '诊断已导出',
    successMessage: '诊断 ZIP 已保存',
    successDetail: '已写入 {count} 个日志文件（{bytes} 字节）至：\n{path}',
    failureTitle: '导出失败',
    failureMessage: '无法导出诊断',
  },
  updates: {
    upToDateTitle: '已是最新',
    upToDateMessage: 'Subcast {version} 已是最新版本。',
    availableTitle: '发现新版本',
    availableMessage: 'Subcast {latest} 已发布',
    availableDetail: '当前版本：{current}。前往发布页查看下载链接与更新说明。',
    openDownload: '打开下载页',
    later: '稍后',
    failedTitle: '更新检查失败',
    failedMessage: '无法连接 GitHub',
  },
};

function resolveLocale(): Locale {
  const raw = app.getLocale().toLowerCase();
  return raw.startsWith('zh') ? 'zh' : 'en';
}

let cached: Bundle | null = null;

export function i18n(): Bundle {
  if (cached) return cached;
  cached = resolveLocale() === 'zh' ? ZH : EN;
  return cached;
}

/**
 * Lightweight ICU-style interpolation: replaces `{key}` with `params[key]`.
 * No pluralization or select — keep the helper tiny so the dictionary
 * stays the source of truth.
 */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : `{${key}}`,
  );
}
