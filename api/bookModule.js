// bookModule.js - 책 검색 및 데이터 처리 전용 모듈
// 위치: api/bookModule.js

let fetchNotion;
let envVars;

export function initializeBookRoutes(app, _fetchNotion, _envVars) {
    fetchNotion = _fetchNotion;
    envVars = _envVars;

    // 1. 영어 원서 검색 API
    app.get('/api/search-books', async (req, res) => {
        const { query } = req.query;
        try {
            if (!envVars.ENG_BOOKS_ID) throw new Error('English Book DB ID missing');
            
            const filter = query ? { property: 'Title', title: { contains: query } } : undefined;
            const data = await fetchNotion(`https://api.notion.com/v1/databases/${envVars.ENG_BOOKS_ID}/query`, {
                method: 'POST',
                body: JSON.stringify({ filter, page_size: 20 })
            });

            const books = data.results.map(page => ({
                id: page.id,
                title: page.properties.Title?.title?.[0]?.plain_text || 'No Title',
                author: page.properties.Author?.rich_text?.[0]?.plain_text || '',
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

            // [중요] 한국어 책은 '책제목' 속성으로 검색
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
    
    console.log('✅ 책 검색 모듈(bookModule.js)이 활성화되었습니다.');
}

/**
 * [헬퍼] 저장할 책 데이터 포맷팅 (ID 없으면 검색 시도)
 */
export async function processBookRelations(bookDataArray, dbId, searchPropName) {
    if (!bookDataArray || !Array.isArray(bookDataArray) || bookDataArray.length === 0) {
        return { relation: [] }; 
    }

    const relations = [];

    for (const book of bookDataArray) {
        if (book.id) {
            // ID가 있으면 바로 연결
            relations.push({ id: book.id });
        } else if (book.title) {
            // [핵심 수정] ID가 없고 제목만 있는 경우, Notion에서 검색하여 ID 찾기 시도
            try {
                let filterBody;
                if (searchPropName === 'Title') {
                    filterBody = { property: 'Title', title: { equals: book.title } };
                } else {
                    // 한국어 책의 경우 '책제목' (rich_text)
                    filterBody = { property: searchPropName, rich_text: { equals: book.title } };
                }

                const searchRes = await fetchNotion(`https://api.notion.com/v1/databases/${dbId}/query`, {
                    method: 'POST',
                    body: JSON.stringify({ filter: filterBody, page_size: 1 })
                });

                if (searchRes.results.length > 0) {
                    relations.push({ id: searchRes.results[0].id });
                    console.log(`[BookModule] Found ID for "${book.title}": ${searchRes.results[0].id}`);
                } else {
                    console.warn(`[BookModule] Could not find book "${book.title}" in DB.`);
                }
            } catch (e) {
                console.error(`[BookModule] Error finding book "${book.title}":`, e);
            }
        }
    }

    return { relation: relations };
}