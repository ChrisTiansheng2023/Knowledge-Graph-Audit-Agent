import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, 'expense-audit-knowledge-graph.html');
const neo4jUrl = (process.env.NEO4J_URL || 'http://localhost:7474').replace(/\/$/, '');
const neo4jDatabase = process.env.NEO4J_DATABASE || 'neo4j';
const neo4jUser = process.env.NEO4J_USER || 'neo4j';
const neo4jPassword = process.env.NEO4J_PASSWORD;
const tenantId = process.env.TENANT_ID || 'HC';
const host = process.env.APP_HOST || '127.0.0.1';
const port = Number(process.env.APP_PORT || 4174);

if (!neo4jPassword) {
  console.error('缺少 NEO4J_PASSWORD，请通过环境变量提供 Neo4j 密码。');
  process.exit(1);
}

const basicAuth = Buffer.from(`${neo4jUser}:${neo4jPassword}`).toString('base64');

async function query(statements) {
  const response = await fetch(`${neo4jUrl}/db/${encodeURIComponent(neo4jDatabase)}/tx/commit`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      statements: statements.map(item => ({
        statement: item.statement,
        parameters: item.parameters || {},
        resultDataContents: ['row'],
      })),
    }),
  });
  if (!response.ok) throw new Error(`Neo4j HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map(error => `${error.code}: ${error.message}`).join('\n'));
  return payload.results;
}

function rows(result) {
  return (result?.data || []).map(item => Object.fromEntries(result.columns.map((column, index) => [column, item.row[index]])));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function safeFields(properties, preferred = []) {
  const hidden = new Set([
    'tenantId','id','sourceSystem','sourceRecordId','schemaVersion','ontologyType','importBatchId',
    'createdAt','updatedAt','ingestedAt','isDeleted','rulePayloadJson','payloadUpdatedAt','sourceFile',
  ]);
  const ordered = [...preferred, ...Object.keys(properties || {})];
  const seen = new Set();
  const output = [];
  for (const key of ordered) {
    if (seen.has(key) || hidden.has(key) || properties?.[key] === undefined || properties?.[key] === null || properties?.[key] === '') continue;
    seen.add(key);
    const raw = properties[key];
    const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    output.push([key, value.length > 120 ? `${value.slice(0, 117)}…` : value]);
    if (output.length >= 12) break;
  }
  return output;
}

const typeDescriptions = {
  ExpenseReport: '员工提交并经过审批、财务审核和付款的报销单据，是一次费用审核的业务入口。',
  ExpenseLine: '报销单内可独立分类、取证和执行规则的最小费用单元。',
  ExpenseCategory: '用于选择适用规则、制度、发票与附件要求的费用分类。',
  Employee: '本次费用报销的提交人；演示数据不包含真实个人敏感信息。',
  HospitalityApplication: '业务招待发生前审批的日期、人数和预算。',
  Invoice: '与费用明细关联且已完成验真的合法票据。',
  AuditRuleDefinition: '判断业务招待费申请金额是否小于或等于当前有效标准。',
  ThresholdStandard: '业务招待费当前有效的单次限额标准。',
  PolicyClause: '审核规则所引用的受控制度条款。',
  AuditCase: '围绕报销单创建的审核运行上下文。',
  RuleExecution: '规则版本在当前事实快照上的执行记录。',
  Finding: '规则执行产生的异常、警告、阻断或通过结果。',
  HumanReviewTask: '证据不足、规则冲突或弱管控异常产生的人工复核任务。',
  AuditDecision: '人工或系统对审核发现作出的放行、扣减、退回或转审决策。',
};

function amount(value) {
  return Number.isFinite(Number(value)) ? (Number(value) / 100).toFixed(2) : '0.00';
}

function caseDisplay(type, properties) {
  switch (type) {
    case 'ExpenseReport': return { label:`报销单 ${properties.reportNo || properties.id}`, shortLabel:'报销单' };
    case 'ExpenseLine': return { label:`业务招待费 ${amount(properties.claimedAmountMinor)}元`, shortLabel:'费用明细' };
    case 'ExpenseCategory': return { label:properties.categoryName || '业务招待费', shortLabel:'业务招待费' };
    case 'Employee': return { label:`员工 ${properties.employeeNo || ''}`.trim(), shortLabel:'报销员工' };
    case 'HospitalityApplication': return { label:`招待申请 ${properties.applicationNo || ''}`.trim(), shortLabel:'招待申请' };
    case 'Invoice': return { label:`餐饮发票 ${amount(properties.totalAmountMinor)}元`, shortLabel:'餐饮发票' };
    case 'AuditRuleDefinition': return { label:properties.ruleName || '业务招待费限额审核', shortLabel:'限额规则' };
    case 'ThresholdStandard': return { label:`公司标准 ${amount(properties.limitAmountMinor)}元`, shortLabel:'公司标准' };
    case 'PolicyClause': return { label:properties.title || '费用报销管理制度', shortLabel:'制度条款' };
    case 'AuditCase': return { label:`审核任务 ${properties.caseNo || ''}`.trim(), shortLabel:'审核任务' };
    case 'RuleExecution': return { label:`规则执行：${properties.result === 'FAILED' ? '不通过' : '通过'}`, shortLabel:'规则执行' };
    case 'Finding': return properties.findingType === 'OVER_LIMIT'
      ? { label:`超标 ${amount(properties.impactAmountMinor)}元`, shortLabel:`超标${Number(amount(properties.impactAmountMinor)).toFixed(0)}元` }
      : { label:'未发现超标', shortLabel:'审核通过' };
    case 'HumanReviewTask': return { label:properties.status === 'SKIPPED' ? '无需人工复核' : '等待财务人工复核', shortLabel:properties.status === 'SKIPPED' ? '无需复核' : '人工复核' };
    case 'AuditDecision': return properties.decisionType === 'PASS'
      ? { label:`建议放行 ${amount(properties.approvedAmountMinor)}元`, shortLabel:'建议放行' }
      : { label:`建议扣减 ${amount(properties.deductedAmountMinor || properties.impactAmountMinor || 10000)}元`, shortLabel:'审核决策' };
    default: return { label:properties.name || properties.title || properties.id || type, shortLabel:type };
  }
}

async function graphData() {
  const results = await query([
    {
      statement: `
        MATCH (n:OntologyClass)
        OPTIONAL MATCH (n)-[:HAS_PROPERTY]->(p:OntologyProperty)
        WITH n, collect(p)[0..12] AS propertyDefinitions
        RETURN n.id AS id,
               coalesce(n.name, n.nameCn, n.id) AS label,
               coalesce(n.layer, 'D') AS layer,
               coalesce(n.description, n.definition, '') AS description,
               [p IN propertyDefinitions | [coalesce(p.fieldName, p.propertyId), coalesce(p.dataType, 'STRING') + CASE WHEN p.required THEN ' · 必填' ELSE '' END]] AS fields
        ORDER BY layer, label
      `,
    },
    {
      statement: `
        MATCH (source:OntologyClass)-[r]->(target:OntologyClass)
        WHERE type(r) STARTS WITH 'REL_'
        RETURN source.id AS source,
               target.id AS target,
               type(r) AS type,
               coalesce(r.name, type(r)) AS label
        ORDER BY type
      `,
    },
    {
      statement: `
        MATCH (n:Entity {tenantId: $tenantId, sourceSystem: 'DEMO'})
        OPTIONAL MATCH (n)-[:INSTANCE_OF]->(class:OntologyClass)
        RETURN n.id AS id,
               labels(n) AS labels,
               properties(n) AS properties,
               coalesce(class.id, n.ontologyType, head([label IN labels(n) WHERE label <> 'Entity'])) AS ontologyType,
               coalesce(class.layer,
                 CASE WHEN any(label IN labels(n) WHERE label IN ['AuditRule','AuditRuleDefinition','ThresholdStandard','PolicyClause']) THEN 'R'
                      WHEN any(label IN labels(n) WHERE label IN ['AuditCase','RuleExecution','Finding','HumanReviewTask','AuditDecision']) THEN 'E'
                      ELSE 'D' END) AS layer
        ORDER BY layer, id
      `,
      parameters: { tenantId },
    },
    {
      statement: `
        MATCH (source:Entity {tenantId: $tenantId, sourceSystem: 'DEMO'})-[r]->(target:Entity {tenantId: $tenantId, sourceSystem: 'DEMO'})
        WHERE type(r) <> 'INSTANCE_OF'
        RETURN source.id AS source,
               target.id AS target,
               type(r) AS type,
               coalesce(r.name, type(r)) AS label
        ORDER BY type
      `,
      parameters: { tenantId },
    },
    {
      statement: `
        MATCH (source:Entity {tenantId: $tenantId, sourceSystem: 'DEMO'})-[r:INSTANCE_OF]->(target:OntologyClass)
        RETURN source.id AS source,
               target.id AS target,
               'INSTANCE_OF' AS type,
               '实例属于' AS label
        ORDER BY source
      `,
      parameters: { tenantId },
    },
  ]);

  const schemaNodes = rows(results[0]).map(row => ({
    id: row.id,
    label: row.label,
    layer: row.layer,
    kind: 'class',
    desc: row.description,
    fields: row.fields || [],
  }));
  const schemaLinks = rows(results[1]).map((row, index) => ({ id:`DB-SL-${index + 1}`, ...row, scope:'schema' }));
  const caseNodes = rows(results[2]).map(row => {
    const properties = row.properties || {};
    const type = row.ontologyType;
    const display = caseDisplay(type, properties);
    const preferred = {
      ExpenseReport:['reportNo','expenseTotalMinor','approvedTotalMinor','currencyCode','status'],
      ExpenseLine:['lineNo','description','claimedAmountMinor','approvedAmountMinor','currencyCode','status'],
      Finding:['findingType','impactAmountMinor','riskLevel','confidence','status'],
      RuleExecution:['result','engineVersion','durationMs','confidence','status'],
      AuditDecision:['decisionType','decisionReason','approvedAmountMinor','currencyCode','status'],
    }[type] || [];
    return {
      id: row.id,
      ...display,
      type,
      layer: row.layer,
      kind: 'instance',
      desc: properties.description || typeDescriptions[type] || `Neo4j 中的 ${type} 业务实例。`,
      fields: safeFields(properties, preferred),
    };
  });
  const caseLinks = rows(results[3]).map((row, index) => ({ id:`DB-CL-${index + 1}`, ...row, scope:'case' }));
  const bridgeLinks = rows(results[4]).map((row, index) => ({ id:`DB-BL-${index + 1}`, ...row, scope:'bridge' }));
  return {
    database: neo4jDatabase,
    tenantId,
    loadedAt: new Date().toISOString(),
    schemaNodes,
    schemaLinks,
    caseNodes,
    caseLinks,
    bridgeLinks,
  };
}

async function healthData() {
  const [rootResponse, results] = await Promise.all([
    fetch(`${neo4jUrl}/`, { headers: { 'Authorization': `Basic ${basicAuth}` } }).then(response => response.json()),
    query([
      { statement:'MATCH (n) RETURN count(n) AS nodes' },
      { statement:'MATCH ()-[r]->() RETURN count(r) AS relationships' },
      { statement:'MATCH (c:OntologyClass) RETURN count(c) AS ontologyClasses' },
      { statement:'MATCH (rule:AuditRule) RETURN count(rule) AS auditRules' },
    ]),
  ]);
  return {
    ok: true,
    database: neo4jDatabase,
    tenantId,
    neo4jVersion: rootResponse.neo4j_version,
    neo4jEdition: rootResponse.neo4j_edition,
    nodes: rows(results[0])[0]?.nodes || 0,
    relationships: rows(results[1])[0]?.relationships || 0,
    ontologyClasses: rows(results[2])[0]?.ontologyClasses || 0,
    auditRules: rows(results[3])[0]?.auditRules || 0,
  };
}

async function audit(payload) {
  const claimAmount = Number(payload?.claimAmount);
  const standardAmount = Number(payload?.standardAmount);
  if (!Number.isFinite(claimAmount) || !Number.isFinite(standardAmount) || claimAmount < 0 || standardAmount < 0 || claimAmount > 1_000_000_000 || standardAmount > 1_000_000_000) {
    const error = new Error('申请金额和公司标准必须是有效的非负数。');
    error.status = 400;
    throw error;
  }
  const claimMinor = Math.round(claimAmount * 100);
  const standardMinor = Math.round(standardAmount * 100);
  const result = await query([{
    statement: `
      MATCH (line:ExpenseLine {tenantId:$tenantId, id:'EL-001'})
      MATCH (invoice:Invoice {tenantId:$tenantId, id:'INV-001'})
      MATCH (application:HospitalityApplication {tenantId:$tenantId, id:'APP-001'})
      MATCH (standard:ThresholdStandard {tenantId:$tenantId, id:'STD-HOSPITALITY-001'})
      MATCH (case:AuditCase {tenantId:$tenantId, id:'CASE-001'})
      MATCH (execution:RuleExecution {tenantId:$tenantId, id:'EXEC-001'})
      MATCH (finding:Finding {tenantId:$tenantId, id:'FINDING-001'})
      MATCH (review:HumanReviewTask {tenantId:$tenantId, id:'REVIEW-001'})
      MATCH (decision:AuditDecision {tenantId:$tenantId, id:'DECISION-001'})
      WITH line, invoice, application, standard, case, execution, finding, review, decision,
           $claimMinor AS claimMinor,
           $standardMinor AS standardMinor,
           $claimMinor <= $standardMinor AS passed,
           CASE WHEN $claimMinor > $standardMinor THEN $claimMinor - $standardMinor ELSE 0 END AS excessMinor
      SET line.claimedAmountMinor = claimMinor,
          line.approvedAmountMinor = CASE WHEN passed THEN claimMinor ELSE standardMinor END,
          line.updatedAt = datetime(),
          invoice.totalAmountMinor = claimMinor,
          invoice.updatedAt = datetime(),
          application.approvedAmountMinor = standardMinor,
          application.updatedAt = datetime(),
          standard.limitAmountMinor = standardMinor,
          standard.updatedAt = datetime(),
          execution.result = CASE WHEN passed THEN 'PASSED' ELSE 'FAILED' END,
          execution.status = 'COMPLETED',
          execution.completedAt = datetime(),
          execution.updatedAt = datetime(),
          finding.findingType = CASE WHEN passed THEN 'PASSED' ELSE 'OVER_LIMIT' END,
          finding.title = CASE WHEN passed THEN '业务招待费未超过公司标准' ELSE '业务招待费超过公司标准' END,
          finding.description = CASE WHEN passed
            THEN '申请金额未超过公司标准，限额审核通过'
            ELSE '申请金额超过公司标准，需要财务人工复核' END,
          finding.impactAmountMinor = excessMinor,
          finding.status = CASE WHEN passed THEN 'CLOSED' ELSE 'PENDING_REVIEW' END,
          finding.updatedAt = datetime(),
          review.status = CASE WHEN passed THEN 'SKIPPED' ELSE 'PENDING' END,
          review.updatedAt = datetime(),
          decision.decisionType = CASE WHEN passed THEN 'PASS' ELSE 'DEDUCT' END,
          decision.decisionReason = CASE WHEN passed THEN '未超过公司标准' ELSE '超过公司标准' END,
          decision.approvedAmountMinor = CASE WHEN passed THEN claimMinor ELSE standardMinor END,
          decision.deductedAmountMinor = excessMinor,
          decision.status = 'DRAFT',
          decision.updatedAt = datetime(),
          case.status = CASE WHEN passed THEN 'COMPLETED' ELSE 'PENDING_REVIEW' END,
          case.updatedAt = datetime()
      RETURN passed,
             claimMinor / 100.0 AS claimAmount,
             standardMinor / 100.0 AS standardAmount,
             excessMinor / 100.0 AS excessAmount,
             execution.result AS ruleResult,
             finding.status AS findingStatus,
             decision.decisionType AS recommendedDecision,
             decision.approvedAmountMinor / 100.0 AS approvedAmount
    `,
    parameters: { tenantId, claimMinor, standardMinor },
  }]);
  return rows(result[0])[0];
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw Object.assign(new Error('请求体过大'), { status:413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (request.method === 'GET' && url.pathname === '/') {
      const html = await fs.readFile(htmlPath);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, await healthData());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/graph') {
      sendJson(response, 200, await graphData());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/audit') {
      sendJson(response, 200, await audit(await readBody(request)));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204); response.end(); return;
    }
    sendJson(response, 404, { error:'NOT_FOUND' });
  } catch (error) {
    console.error(error);
    sendJson(response, error.status || 500, { error:error.message || 'INTERNAL_ERROR' });
  }
});

server.listen(port, host, () => {
  console.log(`税智中枢知识图谱已启动：http://${host}:${port}/`);
  console.log(`Neo4j：${neo4jUrl} / ${neo4jDatabase} / tenant=${tenantId}`);
});

for (const signal of ['SIGINT','SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
