# 修改地图 · 在线协作版（GitHub Pages + 私有数据仓库）

压缩包里有两个文件夹，分别放进两个 GitHub 仓库：

| 文件夹 | 放进哪个仓库 | 可见性 | 内容 |
|---|---|---|---|
| `revmap-site/` | `revmap-site` | **Public**（GitHub Pages 免费版只能发布公开仓库） | 网页本身：`index.html`、`cloud.js`、`config.js`、`.nojekyll`。**不含任何论文或审稿内容** |
| `revmap-data/` | `revmap-data` | **Private** | 修改地图的数据：`data.json`（审稿意见、问题、做法、回复、连线）和 `assets.json`（附件和图片） |

为什么分成两个仓库：审稿意见是保密的。GitHub Pages 发布出来的网页任何人都能打开，所以网页里不放数据；数据放在私有仓库里，只有被邀请、并且填了自己 token 的人才能读写。

## 一、注册 GitHub
1. 打开 https://github.com/signup ，填邮箱、密码、用户名（用户名会出现在网址里，例如 `qizeng`），完成邮箱验证。
2. （可选）学生可以在 https://education.github.com 申请 Student Developer Pack，这一步不是必需的。

## 二、建私有数据仓库 `revmap-data`
1. 右上角 **+** → **New repository**。
2. Repository name 填 `revmap-data`，选 **Private**，勾选 **Add a README file**，点 **Create repository**。
3. 在仓库页面点 **Add file → Upload files**，把 `revmap-data/` 里的 `data.json` 和 `assets.json` 拖进去，点 **Commit changes**。

## 三、建网站仓库 `revmap-site` 并发布
1. 再新建一个仓库，名字 `revmap-site`，选 **Public**，勾选 Add a README，创建。
2. **Add file → Upload files**，把 `revmap-site/` 里的 `index.html`、`cloud.js`、`config.js` 拖进去（`.nojekyll` 传不上去也没关系），Commit。
3. 在仓库里点开 `config.js` → 右上角铅笔图标编辑，把 `owner: 'YOUR_GITHUB_NAME'` 改成你的 GitHub 用户名，Commit。
4. 仓库 **Settings → Pages**：Source 选 **Deploy from a branch**，Branch 选 **main**、文件夹 **/(root)**，点 **Save**。
5. 等 1–2 分钟，页面顶部会出现网址：`https://你的用户名.github.io/revmap-site/`。

## 四、邀请合作者
1. 打开 `revmap-data` 仓库 → **Settings → Collaborators → Add people**，输入合作者的 GitHub 用户名或邮箱。
2. 合作者在邮件或 GitHub 通知里点 **Accept invitation**。
（网站仓库 `revmap-site` 不需要邀请，大家只是打开它的网址。）

## 五、每个人生成自己的 token（第一次打开网站时要填）
**推荐：classic token（对合作者最省事）**
1. GitHub 右上角头像 → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**。
2. Note 随便写（如 `revmap`），Expiration 选 90 天，勾选 **repo**，点 **Generate token**。
3. 复制以 `ghp_` 开头的 token（只显示一次）。

**更细的权限：fine-grained token**（仓库拥有者自己用最合适）
- **Tokens (fine-grained) → Generate new token**；Repository access 选 **Only select repositories → revmap-data**；Permissions 里 **Contents** 选 **Read and write**。
- 如果合作者在这里选不到 `revmap-data`（仓库属于别人的个人账号时可能出现），就改用上面的 classic token。

## 六、使用
- 打开网址，粘贴 token，点「连接并载入」。token 只存在这台电脑的浏览器里；在公用电脑上用完请点左下角「退出」。
- 编辑后停 15 秒自动同步，也可以点左下角「立即同步」或按 Ctrl/⌘ + Shift + S。顶部的状态会显示「已同步到 GitHub hh:mm」或「有未同步的修改」。
- 每 45 秒检查一次合作者的新修改；你正在输入时不会打断，离开输入框后再载入。
- 多人同时修改时，按「条目 + 字段」合并：你改 A 题、他改 B 题，两边都保留；两个人同时改同一条的同一个字段，后同步的人的版本保留，并会弹出提示。
- 每次同步都是 `revmap-data` 里的一次 commit。想找回旧版本：打开 `data.json` → **History**，可以看到谁在什么时候改了什么，复制旧版本内容覆盖即可。
- 页面右上角的「保存」仍然可以把整张地图下载成一个离线 HTML 备份。

## 注意
- 这不是 Google Docs 那样逐字实时协作：同一字段在两次同步之间被两个人改，只保留一份。
- 附件存在 `assets.json` 里。单个附件不要太大（建议 10 MB 以内），否则同步可能失败。
- `config.js` 里的 `autoSyncSeconds`、`pollSeconds` 可以调整同步和检查的频率。GitHub 对每个 token 每小时有 5,000 次 API 请求的上限，默认设置远低于这个数。
