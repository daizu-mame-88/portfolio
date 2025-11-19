// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
    // ユーザーのGitHub PagesルートURLを設定
    site: 'https://daizu-mame-88.github.io',

    // リポジトリ名を設定（GitHub Pagesのサブディレクトリ）
    base: '/portfolio',

    // ... その他の設定
});