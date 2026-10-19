/* 只需要改这里：数据仓库（建议设为 Private）的拥有者和名字 */
window.REVMAP_CONFIG = {
  owner: 'qz2874-create',   // 数据仓库所在的 GitHub 用户名或组织名
  repo: 'data',         // 数据仓库名（私有仓库）
  branch: 'main',              // 分支
  dataPath: 'data.json',       // 修改地图的数据
  assetsPath: 'assets.json',   // 附件（图片、HTML 报告等）
  autoSyncSeconds: 15,         // 停止编辑多少秒后自动同步
  pollSeconds: 45              // 多少秒检查一次合作者的新修改
};
