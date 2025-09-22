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
    
    // 일반 검색으로 데이터베이스 찾기 (필터 없이)
    const response = await notion.search({
      query: "",
      sort: {
        direction: 'descending',
        timestamp: 'last_edited_time'
      }
    });

    // 결과에서 데이터베이스만 필터링
    const databases = response.results.filter(item => item.object === 'database');

    if (databases.length === 0) {
      console.log("❌ 접근 가능한 데이터베이스를 찾을 수 없습니다.");
      console.log("💡 Notion에서 데이터베이스를 공유하고 통합에 액세스 권한을 부여했는지 확인하세요.");
      console.log("💡 데이터베이스가 있다면 다음과 같이 확인해보세요:");
      console.log("   1. Notion에서 데이터베이스 페이지로 이동");
      console.log("   2. 페이지 우상단의 '공유' 버튼 클릭");
      console.log("   3. '통합 추가' 또는 '연결' 섹션에서 이 통합을 추가");
      return;
    }

    console.log("✅ 성공적으로 노션에 연결했습니다!");
    console.log(`\n📋 접근 가능한 데이터베이스 ${databases.length}개를 찾았습니다:`);
    
    databases.forEach((database, index) => {
      const title = database.title && database.title.length > 0 
        ? database.title[0].plain_text || "제목 없음"
        : "제목 없음";
      console.log(`${index + 1}. 📊 ${title}`);
      console.log(`   ID: ${database.id}`);
      console.log(`   마지막 수정: ${new Date(database.last_edited_time).toLocaleString('ko-KR')}`);
      console.log("");
    });

  } catch (error) {
    console.error("❌ 연결에 실패했습니다:", error.message);
    
    if (error.message.includes('Notion not connected')) {
      console.log("💡 Notion 통합이 올바르게 설정되지 않았습니다. Replit에서 Notion 연결을 다시 설정해주세요.");
    } else if (error.status === 401) {
      console.log("💡 인증에 실패했습니다. Notion 통합 설정을 다시 확인해주세요.");
    } else if (error.status === 403) {
      console.log("💡 권한이 없습니다. Notion에서 통합에 적절한 권한을 부여했는지 확인해주세요.");
    }
  }
}

// 프로그램 실행
if (import.meta.url === `file://${process.argv[1]}`) {
  getDatabaseTitle();
}