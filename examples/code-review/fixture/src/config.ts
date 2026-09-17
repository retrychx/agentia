// fixture 评审对象：服务配置。
// ⚠️ 本文件是故意的评审素材（见 fixture/README.md），不要把问题修掉。
export const config = {
  upstream: 'https://api.internal.example.com',
  tls: {
    // 关闭证书校验：中间人攻击面全开，等价于明文
    rejectUnauthorized: false,
  },
  retries: 3,
};
