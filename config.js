// ═══════════════════════════════════════════════════════════
//  Firebase 配置
//
//  怎么拿到这些值：
//   1. 打开 https://console.firebase.google.com 新建项目
//   2. 左侧「构建 → Realtime Database」→ 创建数据库
//      （位置选 asia-southeast1 新加坡，对越南和中国延迟最低）
//   3. 左侧「构建 → Authentication」→ 开启「匿名」登录方式
//   4. 项目设置 ⚙ → 滚到底「你的应用」→ 添加网页应用 </> → 复制 config
//   5. 把下面这几行替换掉
//
//  注意：这些值是公开的，放进 GitHub 公开仓库没有安全问题。
//  真正保护数据的是数据库规则（见 database.rules.json）。
// ═══════════════════════════════════════════════════════════

export const FIREBASE_CONFIG = {
  apiKey: 'PASTE_YOUR_API_KEY',
  authDomain: 'your-project.firebaseapp.com',
  databaseURL: 'https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000000000',
};

// 房间号：同一个房间号的人才能碰到彼此
export const DEFAULT_ROOM = 'arena-01';
