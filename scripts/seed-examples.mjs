/**
 * 导入示例提示词（可选）。
 * 用法: node scripts/seed-examples.mjs [port]
 * 已存在同名同正文的条目会被跳过，不会产生重复。
 */

const PORT = Number(process.argv[2] || process.env.PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;

const EXAMPLES = [
  {
    title: '代码审查清单',
    tags: ['代码', '审查'],
    description: '提交前或评审 PR 时用，按序逐项过一遍',
    content: `请按以下顺序审查这段代码，逐项给出结论，发现问题时给出修改后的代码：

1. 正确性：逻辑是否符合预期；边界条件（空值、0、负数、空集合、超长字符串）是否覆盖
2. 异常处理：是否有吞异常、过宽 catch、资源未释放
3. 并发安全：共享可变状态、锁粒度、线程池配置、接口幂等性
4. 数据库：索引命中、N+1 查询、事务边界、是否存在 SQL 注入
5. 安全：鉴权、越权、敏感信息脱敏、日志是否泄露凭据
6. 可维护性：命名、重复代码、魔法值、嵌套层级

最后用一句话给出总体风险等级（高 / 中 / 低）。`,
  },
  {
    title: '公众号教程开篇',
    tags: ['写作', '公众号'],
    description: '技术教程的引言部分，避免套话',
    content: `写一篇公众号技术教程的开篇引言，要求：

1. 用一个具体的踩坑场景开头，不要用"随着技术发展""在当今互联网时代"这类套话
2. 说明这篇要解决什么问题，以及读完之后读者能得到什么
3. 给出全文结构预告，3 到 5 个要点即可
4. 语气平实克制，不用感叹号，不堆砌形容词
5. 篇幅控制在 300 字左右`,
  },
  {
    title: '周报生成',
    tags: ['汇报', '周报'],
    description: '每周五用，按固定结构收敛信息',
    content: `根据我提供的本周工作记录生成周报，结构如下：

一、本周完成：按项目归类，每条写清结果，不写流水账过程
二、关键问题与处理：问题是什么、根因、当前状态
三、下周计划：可量化、可验收的目标，不要写"继续推进"
四、需要的支持：没有则省略这一节

要求：不夸大成果，不隐藏风险，总量控制在 600 字以内。`,
  },
];

let created = 0;
let skipped = 0;
let failed = 0;

for (const example of EXAMPLES) {
  try {
    const res = await fetch(`${BASE}/api/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(example),
    });
    const data = await res.json();
    if (res.ok) {
      created += 1;
      console.log(`  新建  ${example.title}`);
    } else if (String(data.error || '').includes('already exists')) {
      skipped += 1;
      console.log(`  跳过  ${example.title}（已存在）`);
    } else {
      failed += 1;
      console.log(`  失败  ${example.title} -> ${data.error}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`  失败  ${example.title} -> ${err.message}`);
    console.log('  请确认服务已启动: node ~/.workbuddy/prompt-vault/web/serve.mjs');
    break;
  }
}

console.log(`\n完成：新建 ${created}，跳过 ${skipped}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
