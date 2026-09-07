/// 后端路径是「目录 + 分隔符 + 条目名」，两种分隔符都认
export const isUnder = (path: string, dir: string): boolean => {
  const base = dir.replace(/[/\\]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
};
