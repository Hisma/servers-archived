#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  CallToolResult,
  TextContent,
  ImageContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Page } from "puppeteer";

// Define the tools once to avoid repetition
const TOOLS: Tool[] = [
  {
    name: "puppeteer_navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        launchOptions: { type: "object", description: "PuppeteerJS LaunchOptions. Default null. If changed and not null, browser restarts." },
        allowDangerous: { type: "boolean", description: "Allow dangerous LaunchOptions that reduce security. Default false." },
      },
      required: ["url"],
    },
  },
  {
    name: "puppeteer_screenshot",
    description: "Take a screenshot of the current page or a specific element",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the screenshot" },
        selector: { type: "string", description: "CSS selector for element to screenshot" },
        width: { type: "number", description: "Width in pixels (default: 800)" },
        height: { type: "number", description: "Height in pixels (default: 600)" },
        encoded: { type: "boolean", description: "If true, return base64 data URI. Default false." },
      },
      required: ["name"],
    },
  },
  {
    name: "puppeteer_click",
    description: "Click an element on the page",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector for element to click" } },
      required: ["selector"],
    },
  },
  {
    name: "puppeteer_fill",
    description: "Fill out an input field",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for input field" },
        value: { type: "string", description: "Value to fill" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "puppeteer_select",
    description: "Select a value in a dropdown",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for select element" },
        value: { type: "string", description: "Value to select" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "puppeteer_hover",
    description: "Hover an element on the page",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector for element to hover" } },
      required: ["selector"],
    },
  },
  {
    name: "puppeteer_evaluate",
    description: "Execute JavaScript in the browser context",
    inputSchema: {
      type: "object",
      properties: { script: { type: "string", description: "JavaScript code to run" } },
      required: ["script"],
    },
  },
];

// Global state
let browser: Browser | null = null;
let page: Page | null = null;
const consoleLogs: string[] = [];
const screenshots = new Map<string, string>();
let previousLaunchOptions: any = null;

async function ensureBrowser({ launchOptions, allowDangerous }: any): Promise<Page> {
  const DANGEROUS_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox', '--single-process',
    '--disable-web-security', '--ignore-certificate-errors',
    '--disable-features=IsolateOrigins','--disable-site-isolation-trials',
    '--allow-running-insecure-content'
  ];

  let envConfig = {};
  try { envConfig = JSON.parse(process.env.PUPPETEER_LAUNCH_OPTIONS || '{}'); } catch {}
  const mergedConfig = deepMerge(envConfig, launchOptions || {});

  if (mergedConfig.args) {
    const invalid = mergedConfig.args.filter((a: string) => DANGEROUS_ARGS.some(d => a.startsWith(d)));
    if (invalid.length && !(allowDangerous || process.env.ALLOW_DANGEROUS === 'true')) {
      throw new Error(`Dangerous args detected: ${invalid.join(', ')}`);
    }
  }

  // Close if disconnected or options changed
  try {
    if (browser && !browser.isConnected()) { await browser.close(); browser = null; }
    else if (browser && launchOptions && JSON.stringify(launchOptions) !== JSON.stringify(previousLaunchOptions)) {
      await browser.close(); browser = null;
    }
  } catch { browser = null; }
  previousLaunchOptions = launchOptions;

  if (!browser) {
    const defaults = process.env.DOCKER_CONTAINER
      ? { headless: true, args: ['--no-sandbox','--single-process','--no-zygote'] }
      : { headless: false };
    browser = await puppeteer.launch(deepMerge(defaults, mergedConfig));
    const pages = await browser.pages();
    page = pages[0];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      server.notification({ method:'notifications/resources/updated', params:{ uri:'console://logs' }});
    });
  }
  return page!;
}

function deepMerge(target: any, source: any): any {
  if (typeof target !== 'object' || typeof source !== 'object') return source;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const t = target[key], s = source[key];
    if (Array.isArray(t) && Array.isArray(s)) out[key] = Array.from(new Set([...t, ...s]));
    else if (s && typeof s === 'object') out[key] = deepMerge(t, s);
    else out[key] = s;
  }
  return out;
}

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
  const pg = await ensureBrowser(args);
  switch (name) {
    case 'puppeteer_navigate':
      await pg.goto(args.url);
      return { content:[{ type:'text', text:`Navigated to ${args.url}`}], isError:false };

    case 'puppeteer_screenshot': {
      const w = args.width ?? 800, h = args.height ?? 600;
      await pg.setViewport({ width:w, height:h });
      const shot = await (args.selector ? (await pg.$(args.selector))?.screenshot({ encoding:'base64' }) : pg.screenshot({ encoding:'base64' }));
      if (!shot) return { content:[{ type:'text', text:'Screenshot failed' }], isError:true };
      screenshots.set(args.name, shot as string);
      server.notification({ method:'notifications/resources/updated', params:{ uri:`screenshot://${args.name}`} });
      server.notification({ method:'notifications/resources/list_changed' });
      return { content:[
        { type:'text', text:`Screenshot '${args.name}' at ${w}x${h}` } as TextContent,
        args.encoded
          ? ({ type:'text', text:`data:image/png;base64,${shot}` } as TextContent)
          : ({ type:'image', data:shot, mimeType:'image/png' } as ImageContent)
      ], isError:false };
    }

    case 'puppeteer_click':
      try { await pg.click(args.selector); return { content:[{ type:'text', text:`Clicked ${args.selector}`}], isError:false }; }
      catch(e){ return { content:[{ type:'text', text:`Click failed: ${(e as Error).message}`}], isError:true }; }

    case 'puppeteer_fill':
      try { await pg.waitForSelector(args.selector); await pg.type(args.selector, args.value); return { content:[{ type:'text', text:`Filled ${args.selector}`}], isError:false }; }
      catch(e){ return { content:[{ type:'text', text:`Fill failed: ${(e as Error).message}`}], isError:true }; }

    case 'puppeteer_select':
      try { await pg.waitForSelector(args.selector); await pg.select(args.selector,args.value); return { content:[{ type:'text', text:`Selected ${args.selector}`}], isError:false }; }
      catch(e){ return { content:[{ type:'text', text:`Select failed: ${(e as Error).message}`}], isError:true }; }

    case 'puppeteer_hover':
      try { await pg.waitForSelector(args.selector); await pg.hover(args.selector); return { content:[{ type:'text', text:`Hovered ${args.selector}`}], isError:false }; }
      catch(e){ return { content:[{ type:'text', text:`Hover failed: ${(e as Error).message}`}], isError:true }; }

    case 'puppeteer_evaluate':
      try {
        await pg.evaluate(() => {(window as any).mcpHelper={logs:[],originalConsole:{...console}}; ['log','info','warn','error'].forEach(m=>{(console as any)[m]=(...a:any[])=>{(window as any).mcpHelper.logs.push(`[${m}] ${a.join(' ')}`); (window as any).mcpHelper.originalConsole[m](...a);};});});
        const res = await pg.evaluate(args.script);
        const logs = await pg.evaluate(() => { const l=(window as any).mcpHelper.logs; delete (window as any).mcpHelper; return l; });
        return { content:[{ type:'text', text:`Result:\n${JSON.stringify(res,null,2)}\nLogs:\n${logs.join('\n')}`}], isError:false };
      } catch(e){ return { content:[{ type:'text', text:`Eval failed: ${(e as Error).message}`}], isError:true }; }

    default:
      return { content:[{ type:'text', text:`Unknown tool: ${name}`}], isError:true };
  }
}

const server = new Server(
  { name:"hisma/server-puppeteer", version:"0.6.5" },
  { capabilities:{ resources:{}, tools:{} } }
);

server.setRequestHandler(ListResourcesRequestSchema, async ()=>({ resources:[
  { uri:'console://logs', mimeType:'text/plain', name:'Browser console logs' },
  ...Array.from(screenshots.keys()).map(n=>({ uri:`screenshot://${n}`, mimeType:'image/png', name:`Screenshot: ${n}`}))
] }));

server.setRequestHandler(ReadResourceRequestSchema, async req=>{
  const uri=req.params.uri.toString();
  if(uri==='console://logs') return { contents:[{ uri, mimeType:'text/plain', text:consoleLogs.join('\n')}]};
  if(uri.startsWith('screenshot://')){
    const n=uri.split('://')[1]; const b=screenshots.get(n);
    if(b) return { contents:[{ uri, mimeType:'image/png', blob:b}]};
  }
  throw new Error(`Resource not found: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async ()=>({ tools:TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async req=>handleToolCall(req.params.name, req.params.arguments||{}));

async function runServer(){ const t=new StdioServerTransport(); await server.connect(t);} 
runServer().catch(console.error);
process.stdin.on('close',()=>{ console.error('Puppeteer MCP Server closed'); server.close(); });
