FROM node:18-alpine

WORKDIR /app

# نسخ ملفات الحزم أولاً لتسريع البناء
COPY package*.json ./

# تثبيت المكتبات المطلوبة
RUN npm install

# نسخ كافة ملفات المشروع بما فيها cookies.txt
COPY . .

# التأكد من وجود ملف الكوكيز ومنحه صلاحيات القراءة داخل الحاوية
RUN touch cookies.txt

EXPOSE 5000

CMD ["node", "server.js"]
