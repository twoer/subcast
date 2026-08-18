import { defineConfig } from 'vitepress';

// head 条目不会自动拼接 base，需要手动带上前缀
const base = '/subcast/';
const siteUrl = 'https://twoer.github.io/subcast';

const description =
  '免费、离线、隐私优先的音视频转写与翻译桌面应用——飞书妙记、通义听悟的本地免费平替，SenseVoice + Whisper 双引擎、本地 LLM 翻译与 AI 摘要，数据不离开你的电脑。';

const zhGuideSidebar = [
  { text: '安装', link: '/guide/install' },
  { text: '快速上手', link: '/guide/quick-start' },
  { text: '转写引擎', link: '/guide/transcribe' },
  { text: '翻译与 AI 摘要', link: '/guide/translate-insights' },
  { text: '模型管理', link: '/guide/models' },
  { text: '常见问题', link: '/guide/faq' },
];

const enGuideSidebar = [
  { text: 'Installation', link: '/en/guide/install' },
  { text: 'Quick Start', link: '/en/guide/quick-start' },
  { text: 'Transcription Engines', link: '/en/guide/transcribe' },
  { text: 'Translation & AI Summaries', link: '/en/guide/translate-insights' },
  { text: 'Model Management', link: '/en/guide/models' },
  { text: 'FAQ', link: '/en/guide/faq' },
];
export default defineConfig({
  title: 'Subcast',
  description,
  sitemap: { hostname: siteUrl },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    [
      'script',
      {},
      `var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?5476c85b635f88da5680b6bfa0ff27a9";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(hm, s);
})();`,
    ],
    [
      'script',
      {},
      `!function(p){"use strict";!function(t){var s=window,e=document,i=p,c="".concat("https:"===e.location.protocol?"https://":"http://","sdk.51.la/js-sdk-pro.min.js"),n=e.createElement("script"),r=e.getElementsByTagName("script")[0];n.type="text/javascript",n.setAttribute("charset","UTF-8"),n.async=!0,n.src=c,n.id="LA_COLLECT",i.d=n;var o=function(){s.LA.ids.push(i)};s.LA?s.LA.ids&&o():(s.LA=p,s.LA.ids=[],o()),r.parentNode.insertBefore(n,r)}()}({id:"3Qv7YDTIpjbYfZto",ck:"3Qv7YDTIpjbYfZto",autoTrack:true,hashMode:true,screenRecord:true});`,
    ],
    // 注册 ziyuan.baidu.com 并完成站点验证后，取消注释填入实际 token
    // ['meta', { name: 'baidu-site-verification', content: 'codeva-XXXX' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'Subcast,飞书妙记平替,飞书秒记,通义听悟平替,离线转写,语音转文字,视频转文字,本地转写,免费转写软件,Whisper,SenseVoice,字幕生成,双语字幕,AI 摘要,macOS 转写工具',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Subcast' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:image', content: `${siteUrl}/demo/player.webp` }],
    ['meta', { property: 'og:url', content: siteUrl }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  // Project pages live under twoer.github.io/subcast — asset/base paths
  // must be prefixed accordingly.
  base,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/guide/install', activeMatch: '/guide/' },
          { text: '下载', link: 'https://github.com/twoer/subcast/releases' },
        ],
        sidebar: { '/guide/': zhGuideSidebar },
        outline: { label: '本页目录' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        lastUpdated: { text: '最后更新' },
        returnToTop: { label: '回到顶部' },
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色',
        darkModeSwitchTitle: '切换到深色',
        footer: {
          message: '基于 Apache-2.0 许可开源发布',
          copyright: 'Copyright © 2026 Subcast 贡献者',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/install', activeMatch: '/en/guide/' },
          { text: 'Download', link: 'https://github.com/twoer/subcast/releases' },
        ],
        sidebar: { '/en/guide/': enGuideSidebar },
        footer: {
          message: 'Released under the Apache-2.0 License',
          copyright: 'Copyright © 2026 Subcast Contributors',
        },
      },
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/twoer/subcast' },
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '未找到相关结果',
                resetButtonTitle: '清除查询',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
  },
});
