// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind"; // 1. Tailwindインテグレーションをインポート

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
    // ユーザーのGitHub PagesルートURLを設定
    site: 'https://shuya-kk.github.io',

    // リポジトリ名を設定（GitHub Pagesのサブディレクトリ）
    base: '/portfolio',

    // 2. インテグレーション配列に追加
    integrations: [tailwind(), sitemap()],
});