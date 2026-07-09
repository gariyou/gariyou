import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// JS/CSSをすべてindex.htmlに埋め込み、file://でダブルクリック起動できる単一ファイルとしてビルドする
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    // 数年前のブラウザでも構文エラーで白画面にならないよう、変換ターゲットを下げる
    target: "es2018",
  },
});
