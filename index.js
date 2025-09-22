import { Client } from '@notionhq/client';

let connectionSettings;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=notion',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Notion not connected');
  }
  return accessToken;
}

// WARNING: Never cache this client.
// Access tokens expire, so a new client must be created each time.
// Always call this function again to get a fresh client.
export async function getUncachableNotionClient() {
  const accessToken = await getAccessToken();
  return new Client({ auth: accessToken });
}

// 데이터베이스 정보를 요청하는 함수
async function getDatabaseTitle() {
  try {
    // Notion 클라이언트 생성
    const notion = await getUncachableNotionClient();
    
    // 사용자의 데이터베이스 목록 조회
    const response = await notion.search({
      filter: {
        property: 'object',
        value: 'database'
      }
    });

    if (response.results.length === 0) {
      console.log("❌ 접근 가능한 데이터베이스를 찾을 수 없습니다.");
      console.log("💡 Notion에서 데이터베이스를 공유하고 통합에 액세스 권한을 부여했는지 확인하세요.");
      return;
    }

    console.log("✅ 성공적으로 노션에 연결했습니다!");
    console.log("\n📋 접근 가능한 데이터베이스 목록:");
    
    response.results.forEach((database, index) => {
      const title = database.title && database.title.length > 0 
        ? database.title[0].plain_text || "제목 없음"
        : "제목 없음";
      console.log(`${index + 1}. 📊 ${title}`);
      console.log(`   ID: ${database.id}`);
      console.log("");
    });

  } catch (error) {
    console.error("❌ 연결에 실패했습니다:", error.message);
    
    if (error.message.includes('Notion not connected')) {
      console.log("💡 Notion 통합이 올바르게 설정되지 않았습니다. Replit에서 Notion 연결을 다시 설정해주세요.");
    }
  }
}

// 프로그램 실행
if (import.meta.url === `file://${process.argv[1]}`) {
  getDatabaseTitle();
}