<script setup lang="ts">
import logoUrl from '../assets/logo.svg';

type CompareRow = { label: string; us: string; cloud: string; neg?: boolean };

type Platform = { text: string; icon: 'apple' | 'windows'; ok?: boolean; link?: string };

type CompareCopy = {
  title: string;
  lead: string;
  us: string;
  usBadge: string;
  usTagline: string;
  them: string;
  themTagline: string;
  rows: CompareRow[];
  useCaseLabel: string;
  useCases: string[];
  platform: Platform[];
};

const { lang = 'zh' } = defineProps<{ lang?: 'zh' | 'en' }>();

const i18n: Record<'zh' | 'en', CompareCopy> = {
  zh: {
    title: '云端转写的本地平替',
    lead: '在找飞书妙记、通义听悟这类云端转写工具的替代品？Subcast 把整条链路搬到了本地：',
    us: 'Subcast',
    usBadge: '本地运行',
    usTagline: '免费 · 离线 · 数据不出本机',
    them: '云端转写工具',
    themTagline: '上传云端 · 订阅付费 · 全程联网',
    rows: [
      { label: '音视频文件', us: '全程留在本机', cloud: '需上传到服务器', neg: true },
      { label: '费用', us: '免费，无时长限制', cloud: '订阅或时长额度', neg: true },
      { label: '联网', us: '仅下载模型时需要', cloud: '全程需要', neg: true },
      { label: '账号', us: '无需注册', cloud: '通常需要登录', neg: true },
      { label: '输出', us: '双语字幕 VTT / SRT / TXT + AI 摘要', cloud: '视产品而定' },
    ],
    useCaseLabel: '适合场景',
    useCases: ['播客转文字', '会议记录', '网课笔记', '访谈整理', '视频字幕制作'],
    platform: [
      { text: 'macOS · Apple Silicon', icon: 'apple', ok: true, link: 'https://github.com/twoer/subcast/releases/latest' },
      { text: 'Windows 开发中', icon: 'windows' },
    ],
  },
  en: {
    title: 'A local alternative to cloud transcription',
    lead: 'Looking for a replacement for cloud transcription services? Subcast moves the entire pipeline onto your machine:',
    us: 'Subcast',
    usBadge: 'Runs locally',
    usTagline: 'Free · Offline · Your data stays on your machine',
    them: 'Cloud transcription',
    themTagline: 'Uploaded to the cloud · Subscription · Always online',
    rows: [
      { label: 'Media files', us: 'Stay on your machine', cloud: 'Uploaded to servers', neg: true },
      { label: 'Cost', us: 'Free, unlimited duration', cloud: 'Subscription or quotas', neg: true },
      { label: 'Network', us: 'Only to download models', cloud: 'Always required', neg: true },
      { label: 'Account', us: 'No sign-up needed', cloud: 'Usually required', neg: true },
      { label: 'Output', us: 'Bilingual subtitles VTT / SRT / TXT + AI summaries', cloud: 'Varies by product' },
    ],
    useCaseLabel: 'Use cases',
    useCases: ['Podcast to text', 'Meeting notes', 'Course notes', 'Interviews', 'Subtitling'],
    platform: [
      { text: 'macOS · Apple Silicon', icon: 'apple', ok: true, link: 'https://github.com/twoer/subcast/releases/latest' },
      { text: 'Windows in development', icon: 'windows' },
    ],
  },
};

const t = i18n[lang];
</script>

<template>
  <section class="home-compare">
    <header class="hc-head">
      <h2 class="hc-title" id="vs-cloud">{{ t.title }}</h2>
      <p class="hc-lead">{{ t.lead }}</p>
    </header>

    <div class="hc-grid">
      <div class="hc-card hc-card-us">
        <span class="hc-badge">{{ t.usBadge }}</span>
        <div class="hc-card-head">
          <img class="hc-logo" :src="logoUrl" alt="" width="40" height="40" />
          <div>
            <h3 class="hc-name">{{ t.us }}</h3>
            <p class="hc-tagline">{{ t.usTagline }}</p>
          </div>
        </div>
        <ul class="hc-rows">
          <li v-for="row in t.rows" :key="row.label">
            <span class="hc-row-label">{{ row.label }}</span>
            <span class="hc-value">
              <span class="hc-check" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="12" height="12">
                  <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span>{{ row.us }}</span>
            </span>
          </li>
        </ul>
      </div>

      <div class="hc-card hc-card-cloud">
        <div class="hc-card-head">
          <span class="hc-cloud-icon" aria-hidden="true">☁️</span>
          <div>
            <h3 class="hc-name">{{ t.them }}</h3>
            <p class="hc-tagline">{{ t.themTagline }}</p>
          </div>
        </div>
        <ul class="hc-rows">
          <li v-for="row in t.rows" :key="row.label">
            <span class="hc-row-label">{{ row.label }}</span>
            <span class="hc-value">
              <span v-if="row.neg" class="hc-cross" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13">
                  <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
                </svg>
              </span>
              <span :class="{ 'is-neg': row.neg }">{{ row.cloud }}</span>
            </span>
          </li>
        </ul>
      </div>
    </div>

    <div class="hc-uses">
      <span class="hc-uses-label">{{ t.useCaseLabel }}</span>
      <ul class="hc-chips">
        <li v-for="c in t.useCases" :key="c"><span>{{ c }}</span></li>
      </ul>
    </div>

    <ul class="hc-platform">
      <li v-for="p in t.platform" :key="p.text">
        <component
          :is="p.link ? 'a' : 'span'"
          class="hc-pill"
          :class="p.ok ? 'is-ok' : 'is-wip'"
          v-bind="p.link ? { href: p.link, target: '_blank', rel: 'noopener' } : {}"
        >
          <span class="hc-os-icon" aria-hidden="true">
            <svg v-if="p.icon === 'apple'" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor">
              <path d="M0 3.449 9.75 2.1v9.451H0V3.449zm10.949-1.402L24 0v11.4H10.949V2.047zM0 12.6h9.75v9.351L0 20.699V12.6zm10.949 0H24V24l-12.9-1.801V12.6z" />
          </svg>
          </span>
          <span>{{ p.text }}</span>
        </component>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 首页内容实际渲染在 .vp-doc 容器里，VitePress 默认样式 .vp-doc li+li{margin-top:8px}
   会让 flex 列表中后续胶囊下移、首个胶囊被拉伸变高，这里显式清零。
   选择器带 .home-compare 前缀以保证优先级高于 .vp-doc li+li。 */
.home-compare .hc-chips li + li,
.home-compare .hc-platform li + li,
.home-compare .hc-rows li + li {
  margin-top: 0;
}

.home-compare {
  max-width: 1120px;
  margin: 0 auto;
  padding: 48px 24px 72px;
}

.hc-head {
  text-align: center;
  margin-bottom: 40px;
}

.hc-title {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.hc-lead {
  margin: 16px auto 0;
  max-width: 640px;
  font-size: 16px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
}

/* ---- 双卡片对比 ---- */

.hc-grid {
  display: grid;
  grid-template-columns: 1.06fr 0.94fr;
  gap: 24px;
  align-items: stretch;
}

.hc-card {
  position: relative;
  border-radius: 16px;
  padding: 28px 30px 16px;
}

.hc-card-us {
  border: 1.5px solid color-mix(in srgb, var(--vp-c-brand-1) 40%, transparent);
  background: var(--vp-c-brand-soft);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--vp-c-brand-soft) 65%, var(--vp-c-bg)),
    color-mix(in srgb, var(--vp-c-brand-soft) 30%, var(--vp-c-bg))
  );
  box-shadow:
    0 1px 2px rgba(2, 8, 20, 0.04),
    0 18px 44px -20px color-mix(in srgb, var(--vp-c-brand-1) 50%, transparent);
}

.hc-badge {
  position: absolute;
  top: -13px;
  left: 28px;
  padding: 4px 14px;
  border-radius: 999px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--vp-c-brand-1) 60%, transparent);
}

.hc-card-cloud {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
}

.hc-card-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 20px;
}

.hc-logo {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 10px;
}

.hc-cloud-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  font-size: 22px;
}

.hc-name {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.hc-card-us .hc-name {
  color: var(--vp-c-brand-1);
}

.hc-tagline {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

/* ---- 每张卡内部的对比行 ---- */

.hc-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.hc-rows li {
  padding: 13px 0;
}

.hc-rows li + li {
  border-top: 1px dashed var(--vp-c-divider);
}

.hc-card-us .hc-rows li + li {
  border-top-color: color-mix(in srgb, var(--vp-c-brand-1) 22%, transparent);
}

.hc-row-label {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-3);
}

.hc-value {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
}

.hc-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
}

.hc-cross {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  flex-shrink: 0;
  color: var(--vp-c-text-3);
  opacity: 0.7;
}

.hc-card-cloud .hc-value {
  color: var(--vp-c-text-2);
}

/* ---- 场景与平台 ---- */

.hc-uses {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 40px;
}

.hc-uses-label {
  font-size: 14px;
  color: var(--vp-c-text-3);
}

.hc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.hc-chips li {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  line-height: 1;
  white-space: nowrap;
  padding: 7px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-alt);
}

.hc-platform {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
}

.hc-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  padding: 10px 18px;
  border-radius: 999px;
}

.hc-os-icon {
  display: inline-flex;
  align-items: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.hc-os-icon svg {
  width: 100%;
  height: 100%;
}

.hc-pill.is-ok {
  color: var(--vp-c-brand-1);
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 40%, transparent);
  text-decoration: none;
  transition: background-color 0.2s;
}

.hc-pill.is-ok:hover {
  background: var(--vp-c-brand-soft);
}

.hc-pill.is-wip {
  color: var(--vp-c-text-3);
  border: 1px solid var(--vp-c-divider);
}

/* ---- 窄屏：卡片纵向堆叠 ---- */

@media (max-width: 820px) {
  .hc-grid {
    grid-template-columns: 1fr;
    gap: 28px;
  }

  .home-compare {
    padding-top: 36px;
    padding-bottom: 56px;
  }
}
</style>
