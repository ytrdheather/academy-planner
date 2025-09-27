import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@notionhq/client';

// ===== 필수 환경 변수 확인 =====
if (!process.env.NOTION_TOKEN || !process.env.STUDENT_DATABASE_ID) {
  console.error("❌ 필수 환경 변수(NOTION_TOKEN, STUDENT_DATABASE_ID)가 설정되지 않았습니다.");
}

// ===== 기본 설정 =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const STUDENT_DB_ID = process.env.STUDENT_DATABASE_ID;

// ===== 미들웨어 설정 =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 페이지 보여주기 =====
const publicPath = path.join(process.cwd(), 'public');

// 기본 주소('/')로 접속하면 로그인 페이지를 보여줌
app.get('/', (req, res) => {
  try {
    res.sendFile(path.join(publicPath, 'views', 'login.html'));
  } catch (error) {
    console.error("login.html 파일 서빙 오류:", error);
    res.status(500).send("로그인 페이지를 불러오는 중 오류가 발생했습니다.");
  }
});

app.get('/planner', (req, res) => {
    try {
      res.sendFile(path.join(publicPath, 'views', 'planner.html'));
    } catch (error) {
      res.status(500).send("플래너 페이지를 불러오는 중 오류가 발생했습니다.");
    }
});

// ===== 학생 로그인 API 기능 =====
app.post('/api/login', async (req, res) => {
  const { studentId, studentPassword } = req.body;
  
  try {
    const response = await notion.databases.query({
      database_id: STUDENT_DB_ID,
      filter: {
        and: [
          { property: '학생 ID', rich_text: { equals: studentId } },
          { property: '비밀번호', rich_text: { equals: studentPassword } }
        ]
      }
    });

    if (response.results.length > 0) {
      // 실제 JWT 토큰 생성 로직은 나중에 다시 추가하겠습니다.
      res.json({ success: true, message: '로그인 성공!' });
    } else {
      res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (error) {
    console.error('학생 로그인 API 오류:', error);
    res.status(500).json({ success: false, message: '로그인 중 서버 오류가 발생했습니다.' });
  }
});

// ===== Vercel 호환을 위한 최종 핸들러 =====
export default app;
