-- فهرس جزئي: يمنع مسح جدول users كاملًا في إعادة التعيين اليومية لسناب شات
-- UPDATE ... WHERE snapchat_activated_at IS NOT NULL كان يقرأ كل الصفوف (15k+)
-- مع هذا الفهرس يقرأ فقط الصفوف ذات القيمة (عادة 0-قليلة)
CREATE INDEX IF NOT EXISTS idx_users_snap_active ON users(snapchat_activated_at) WHERE snapchat_activated_at IS NOT NULL;
