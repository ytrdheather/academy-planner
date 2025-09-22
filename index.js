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

// 특정 데이터베이스 정보를 직접 요청하는 함수
async function testSpecificDatabase() {
  const databaseId = '25409320bce2807697ede3f1c1b62ada'; // 사용자가 제공한 데이터베이스 ID
  
  try {
    console.log(`🔍 특정 데이터베이스 테스트 중... (ID: ${databaseId})`);
    
    const notion = await getUncachableNotionClient();
    
    // 직접 데이터베이스 정보 조회 시도
    const database = await notion.databases.retrieve({ database_id: databaseId });
    
    const title = database.title && database.title.length > 0 
      ? database.title[0].plain_text || "제목 없음"
      : "제목 없음";
      
    console.log("✅ 성공! 특정 데이터베이스에 접근할 수 있습니다!");
    console.log(`📊 데이터베이스 제목: ${title}`);
    console.log(`🆔 데이터베이스 ID: ${database.id}`);
    console.log(`📅 마지막 수정: ${new Date(database.last_edited_time).toLocaleString('ko-KR')}`);
    
    return true;
  } catch (error) {
    console.error("❌ 특정 데이터베이스 접근 실패:", error.message);
    console.error("오류 코드:", error.code || error.status || "불명");
    
    if (error.code === 'object_not_found') {
      console.log("💡 데이터베이스를 찾을 수 없습니다. ID가 올바른지 확인하세요.");
    } else if (error.code === 'unauthorized') {
      console.log("💡 권한이 없습니다. 데이터베이스가 통합과 공유되어 있는지 확인하세요.");
    }
    
    return false;
  }
}

// 전체 검색으로 데이터베이스 찾기
async function searchAllDatabases() {
  try {
    console.log("\n🔍 전체 검색으로 데이터베이스 찾는 중...");
    
    const notion = await getUncachableNotionClient();
    
    // 일반 검색으로 데이터베이스 찾기 (필터 없이)
    const response = await notion.search({
      query: "",
      sort: {
        direction: 'descending',
        timestamp: 'last_edited_time'
      }
    });

    console.log(`📊 전체 검색 결과: ${response.results.length}개 항목 발견`);
    
    // 모든 결과의 타입을 출력
    const itemTypes = {};
    response.results.forEach(item => {
      itemTypes[item.object] = (itemTypes[item.object] || 0) + 1;
    });
    
    console.log("📋 발견된 항목 타입:");
    Object.entries(itemTypes).forEach(([type, count]) => {
      console.log(`   ${type}: ${count}개`);
    });

    // 결과에서 데이터베이스만 필터링
    const databases = response.results.filter(item => item.object === 'database');

    if (databases.length === 0) {
      console.log("❌ 검색으로도 접근 가능한 데이터베이스를 찾을 수 없습니다.");
      return false;
    }

    console.log(`\n📋 검색으로 찾은 데이터베이스 ${databases.length}개:`);
    
    databases.forEach((database, index) => {
      const title = database.title && database.title.length > 0 
        ? database.title[0].plain_text || "제목 없음"
        : "제목 없음";
      console.log(`${index + 1}. 📊 ${title}`);
      console.log(`   ID: ${database.id}`);
      console.log(`   마지막 수정: ${new Date(database.last_edited_time).toLocaleString('ko-KR')}`);
      console.log("");
    });
    
    return true;

  } catch (error) {
    console.error("❌ 검색에 실패했습니다:", error.message);
    return false;
  }
}

// 데이터베이스 정보를 요청하는 함수 (원래 Python 코드와 유사한 형태로)
async function getDatabaseTitle() {
  // 사용자의 데이터베이스 ID (환경변수에서 가져오거나 하드코딩)
  const databaseId = process.env.NOTION_DATABASE_ID || '25409320bce2807697ede3f1c1b62ada';
  
  try {
    console.log("🔗 노션 데이터베이스에 연결 중...");
    
    // Notion 클라이언트 생성
    const notion = await getUncachableNotionClient();
    
    // 데이터베이스 정보 조회
    const database = await notion.databases.retrieve({ database_id: databaseId });
    
    const title = database.title && database.title.length > 0 
      ? database.title[0].plain_text || "제목 없음"
      : "제목 없음";
      
    console.log("✅ 성공적으로 노션 데이터베이스에 연결했습니다!");
    console.log(`➡️ 데이터베이스 제목: ${title}`);
    console.log(`🆔 데이터베이스 ID: ${database.id}`);
    console.log(`📅 마지막 수정: ${new Date(database.last_edited_time).toLocaleString('ko-KR')}`);
    
    // 데이터베이스의 속성(컬럼) 정보도 출력
    if (database.properties && Object.keys(database.properties).length > 0) {
      console.log("\n📊 데이터베이스 속성:");
      Object.entries(database.properties).forEach(([name, property]) => {
        console.log(`   • ${name} (${property.type})`);
      });
    } else {
      console.log("\n📊 데이터베이스 속성: 없음");
    }

  } catch (error) {
    console.error(`❌ 연결에 실패했습니다. 오류 코드: ${error.code || error.status || "불명"}`);
    console.error(`오류 내용: ${error.message}`);
    
    if (error.code === 'object_not_found') {
      console.log("💡 데이터베이스 ID를 확인하거나 NOTION_DATABASE_ID 환경변수를 설정하세요.");
    } else if (error.code === 'unauthorized') {
      console.log("💡 권한이 없습니다. 노션에서 통합과 데이터베이스를 공유했는지 확인하세요.");
    }
  }
}

// 프로그램 실행
if (import.meta.url === `file://${process.argv[1]}`) {
  getDatabaseTitle();
}