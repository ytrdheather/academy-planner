// bookModule.js - 책 검색 및 데이터 처리 전용 모듈
// 위치: api/bookModule.js (index.js와 같은 폴더)

let fetchNotion;
let envVars;

export function initializeBookRoutes(app, _fetchNotion, _envVars) {
    fetchNotion = _fetchNotion;
    envVars = _envVars;

    // 1. 영어 원서 검색 API (AR, Lexile 포함)
    app.get('/api/search-books', async (req, res) => {
        const { query } = req.query;
        try {
            if (!envVars.ENG_BOOKS_ID) throw new Error('English Book DB ID missing');
            
            // 제목으로 검색 (부분 일치)
            const filter = query ? { property: 'Title', title: { contains: query } } : undefined;
            
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${envVars.ENG_BOOKS_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ 
                    filter, 
                    page_size: 20,
                    // 정렬: 최신순 (선택사항)
                    sorts: [{ timestamp: 'created_time', direction: 'descending' }]
                })
            });

            // [핵심] AR, Lexile 정보 추출
            const books = data.results.map(page => ({
                id: page.id,
                title: page.properties.Title?.title?.[0]?.plain_text || 'No Title',
                author: page.properties.Author?.rich_text?.[0]?.plain_text || '',
                // Notion 속성 타입에 따라 number 또는 select로 처리
                ar: page.properties.AR?.number || page.properties.AR?.select?.name || null, 
                lexile: page.properties.Lexile?.number || page.properties.Lexile?.select?.name || null,
                level: page.properties.Level?.select?.name || ''
            }));
            
            res.json(books);
        } catch (error) {
            console.error('English book search error:', error);
            res.status(500).json([]);
        }
    });

    // 2. 한국어 책 검색 API
    app.get('/api/search-sayu-books', async (req, res) => {
        const { query } = req.query;
        try {
            if (!envVars.KOR_BOOKS_ID) throw new Error('Korean Book DB ID missing');

            const filter = query ? { property: '책제목', rich_text: { contains: query } } : undefined;
            
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${envVars.KOR_BOOKS_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter, page_size: 20 })
            });

            const books = data.results.map(page => ({
                id: page.id,
                title: page.properties.책제목?.rich_text?.[0]?.plain_text || 'No Title',
                author: page.properties.지은이?.rich_text?.[0]?.plain_text || '',
                publisher: page.properties.출판사?.rich_text?.[0]?.plain_text || ''
            }));

            res.json(books);
        } catch (error) {
            console.error('Korean book search error:', error);
            res.status(500).json([]);
        }
    });
    
    console.log('✅ 책 검색 모듈(bookModule.js - AR/Lexile 포함)이 활성화되었습니다.');
}

/**
 * [헬퍼] 저장할 책 데이터 포맷팅 (여러 권 처리 지원)
 * 프론트엔드에서 보낸 { id, title } 배열을 Notion Relation 형태로 변환
 */
export async function processBookRelations(bookDataArray, dbId, searchPropName) {
    if (!bookDataArray || !Array.isArray(bookDataArray) || bookDataArray.length === 0) {
        return { relation: [] }; // 책 없음
    }

    const relations = [];

    for (const book of bookDataArray) {
        if (book.id) {
            // ID가 있으면 바로 연결 (검색해서 선택한 경우)
            relations.push({ id: book.id });
        } else if (book.title) {
            // ID가 없고 제목만 있는 경우 (사용자가 직접 타이핑해서 엔터 친 경우 등)
            // 여기서는 안전을 위해 ID가 없는 데이터는 건너뛰거나, 
            // 필요하다면 findPageIdByTitle 로직을 수행해야 합니다.
            // 현재 구조상 planner.js에서 검색된 책만 배열에 넣으므로 대부분 ID가 있습니다.
            // (직접 입력 지원 시 추가 로직 필요)
        }
    }

    return { relation: relations };
}