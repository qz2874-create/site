/* 只需要改这里：把 owner 改成你的 GitHub 用户名 */
window.REVMAP_CONFIG = {
  owner: 'qz2874-create',      // 数据仓库所在的 GitHub 用户名或组织名
  repo: 'data',            // 数据仓库名（私有仓库）
  branch: 'main',                 // 分支
  dataPath: 'data.json',          // 修改地图的内容
  assetsPath: 'assets.json',      // 图片和附件
  commentsPath: 'comments.json',  // 评论（第一次有人评论时自动创建，不用上传）
  autoSyncSeconds: 15,            // 停止编辑多少秒后自动同步
  pollSeconds: 20                 // 多少秒检查一次别人的新修改和新评论
};
