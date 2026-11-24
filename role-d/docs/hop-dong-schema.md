# Hợp đồng schema D

Nguồn chuẩn duy nhất: [database-schema.md](../../docs/database-schema.md) và migration 001–007 tại packages/socket/migrations.

- Import ghi catalog quizzes/questions của A. questions.position bắt đầu từ 1, definition JSONB giữ nguyên nội dung câu hỏi.
- quiz_imports chỉ giữ metadata S3 bucket/key/ETag, SHA-256, license và quiz_id. Không có question_sets hoặc bản sao document.
- room_id, round_id, player_id là UUID. player_id là clientId ổn định, không phải socket ID.
- answers.choice là integer hoặc null; answer_keys là mảng. event_id lấy từ outbox, không phải answers.
- Điểm ở results; marker tính điểm ở processed_answer_events. Tên người chơi là players.username.
- Export dùng snapshot REPEATABLE READ, gồm cả người không trả lời; ranking tách theo phòng.
- Audit view được tạo bằng migration 007. Chạy experiments/score-audit.sql sau khi worker xử lý hết: sai điểm, thiếu result/outbox/marker đều phải bằng 0.

Đã bỏ các SQL đề xuất riêng trong db/ để tránh tạo bảng trùng hoặc một schema khác với ứng dụng.
