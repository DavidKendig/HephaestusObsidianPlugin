/** SVG files are bundled as text by esbuild's text loader. */
declare module "*.svg" {
  const content: string;
  export default content;
}
